# Relay — Webhook Delivery Service

An event-driven webhook delivery system: publish an event once, and Relay
fans it out to every subscriber endpoint with signed payloads, automatic
retries with exponential backoff, and full delivery observability — the
kind of infrastructure behind Stripe/GitHub-style webhooks.

**Stack:** Node.js, TypeScript, Express, PostgreSQL (Prisma), Redis + BullMQ,
React (Vite) dashboard.

## Why this exists

Most CRUD demos don't say much about how someone handles distributed systems
problems. Webhook delivery is a compact way to show several of them at once:

- **Durable fan-out with rebuildable queue state** — events and deliveries are
  committed to PostgreSQL before BullMQ is treated as the execution projection.
  Deterministic attempt job IDs and periodic reconciliation repair missing Redis
  work after partial infrastructure failures.
- **Idempotent event publishing** — callers can send an `Idempotency-Key` on
  `POST /v1/events`. The key is unique per tenant and bound to a stable
  fingerprint of the event type and JSON payload, so network retries return the
  original event instead of creating a second fan-out. Reusing the key for
  different work returns `409 IDEMPOTENCY_CONFLICT`.
- **Hardened outbound delivery** — webhook targets are limited to HTTP(S),
  credentials and local/private/reserved destinations are rejected, DNS is
  revalidated on every attempt, redirects are not followed, production uses an
  exact-host allowlist, and response bodies are read with a hard byte cap.
- **Race-safe execution and replay** — each durable run/attempt is atomically
  claimed before any outbound request. Duplicate queue work therefore cannot
  send the same attempt concurrently, while manual replay starts a new run with
  a fresh retry budget and keeps prior attempt history intact.
- **At-least-once delivery with idempotent queue projection** — a background
  worker retries failed deliveries with exponential backoff + jitter, capped and
  bounded by a max attempt count, while stale queue projections are ignored.
- **Payload integrity** — outgoing payloads are HMAC-SHA256 signed with a
  per-subscription secret and a timestamp, so receivers can verify authenticity
  and reject replayed requests.
- **Failure isolation** — one subscriber's broken endpoint can't affect
  delivery to any other subscriber; exhausted failures increment the
  subscription failure counter atomically and sustained failure auto-disables it.
- **Full auditability** — every run and attempt is recorded, so an operator can
  see exactly what happened and safely replay a delivery after the receiver is fixed.

## Architecture

```
                    ┌──────────────┐
  POST /v1/events   │              │   INSERT Event
 ──────────────────▶│   API (Express)│   INSERT Delivery (1 per matching
                    │              │    subscription)
                    └──────┬───────┘
                           │ deterministic projection
                           ▼
                    ┌──────────────┐
                    │ Redis (BullMQ)│◀──── periodic reconciliation from Postgres
                    └──────┬───────┘
                           │
                           ▼
                    ┌──────────────┐      signed POST      ┌─────────────┐
                    │  Delivery     │ ─────────────────────▶│ Subscriber  │
                    │  Worker       │                        │ endpoint    │
                    └──────┬───────┘◀───────────────────────└─────────────┘
                           │  failure → persist retry + project next attempt
                           ▼
                    ┌──────────────┐
                    │  PostgreSQL   │  Delivery + DeliveryAttempt history
                    └──────────────┘
```

PostgreSQL is the durable source of truth for delivery state. Redis/BullMQ is
an execution layer that can be rebuilt from `PENDING` and `RETRYING` rows. Queue
jobs are scoped to a delivery `runNumber` + `attemptNumber`, and the worker uses
an atomic `PROCESSING` transition before making an outbound request. A manual
replay increments the run number and resets only the current run's retry budget;
historical attempts remain available for audit/debugging.

The API and worker are two separate processes sharing one codebase, scaled
independently — the API is stateless and scales on request volume, the
worker scales on delivery throughput.

## Webhook destination security

Webhook URLs are untrusted input. Relay validates them when a subscription is
created and again immediately before every outbound request. Delivery rejects
non-HTTP(S) URLs, embedded credentials, localhost, private/link-local/reserved IP
ranges, and cloud metadata-style destinations. Hostnames are resolved at send
time so a DNS change cannot silently turn an originally public target into an
internal address. Redirects are handled with `redirect: "manual"` rather than
followed automatically.

In production, outbound delivery is opt-in through `WEBHOOK_ALLOWED_HOSTS`, a
comma-separated list of exact hostnames. If that list is empty, production
subscription creation/delivery is disabled. This is the primary operational
boundary against DNS rebinding/TOCTOU-style SSRF risk; the DNS/IP checks provide
additional defense in depth. Response bodies are streamed only up to the stored
snippet limit instead of buffering arbitrary endpoint responses in memory.

## Project structure

```
api/
  src/
    modules/            # subscriptions, events, deliveries — HTTP + business logic
    queue/               # BullMQ projection, atomic claims, reconciliation, worker
    lib/                 # signatures, idempotency, network safety, errors, logging
    middleware/          # API key auth, centralized error handling
    __tests__/           # vitest: delivery lifecycle, security, signatures, services
  prisma/schema.prisma   # Tenant, Subscription, Event, Delivery, DeliveryAttempt
web/
  src/
    pages/               # Subscriptions, Events, Deliveries (ops dashboard)
    api/client.ts        # typed fetch client
```

## Running it locally

**With Docker (recommended):**

```bash
docker compose up --build
```

This starts Postgres, Redis, the API (with migrations applied on boot), the
worker, and the dashboard at http://localhost:5173.

**Without Docker**, with local Postgres + Redis running:

```bash
cd api
cp .env.example .env
npm install
npx prisma migrate dev
npm run seed
npm run dev                  # API on :3000
npm run worker:dev           # in a second terminal
```

```bash
cd web
npm install
npm run dev                  # dashboard on :5173
```

## Trying it via the API directly

```bash
# Create a subscription (the response includes the signing secret — save it)
curl -X POST http://localhost:3000/v1/subscriptions \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"targetUrl":"https://webhook.site/your-id","eventTypes":["order.created"]}'

# Publish an event — repeating the exact request with the same Idempotency-Key
# returns the original event instead of creating another fan-out.
curl -X POST http://localhost:3000/v1/events \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Idempotency-Key: order-created-ord-123" \
  -H "Content-Type: application/json" \
  -d '{"type":"order.created","payload":{"orderId":"ord_123","amount":4200}}'
```

The idempotency key is scoped to the authenticated tenant. It is bound to a
SHA-256 fingerprint of the event type and canonicalized JSON payload. Object key
ordering therefore does not change request identity, while changing the event
semantics under the same key is rejected with `409 IDEMPOTENCY_CONFLICT`.

## Verifying signatures as a receiver

```
Webhook-Signature: t=1699999999,v1=<hex hmac-sha256>
```

Recompute `HMAC-SHA256(secret, "${t}.${rawBody}")` and compare it to `v1`
using a constant-time comparison; reject requests whose `t` is more than a
few minutes old. See `src/lib/signature.ts` for the reference implementation.

## Tests

```bash
cd api && npm test
```

CI also applies the committed Prisma migrations to a fresh PostgreSQL database,
runs the API TypeScript build, and builds the React dashboard.

## What I'd add with more time

- Per-subscription delivery rate limiting, so one slow subscriber's queue
  depth can't starve others under the same tenant
- A `deliveries.stats` endpoint (success rate, p95 latency per subscription)
  for the dashboard
- Webhook payload schema registry so publishers get compile-time safety
