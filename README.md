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

- **At-least-once delivery with idempotent retries** — a background worker
  retries failed deliveries with exponential backoff + jitter, capped and
  bounded by a max attempt count, without blocking the request that
  published the event.
- **Payload integrity** — outgoing payloads are HMAC-SHA256 signed with a
  per-subscription secret and a timestamp, the same scheme Stripe and GitHub
  use, so receivers can verify authenticity and reject replayed requests.
- **Failure isolation** — one subscriber's broken endpoint can't affect
  delivery to any other subscriber; a subscription that fails consistently
  is automatically disabled rather than retried forever.
- **Full auditability** — every attempt (not just the latest) is recorded,
  so a support/on-call engineer can see exactly what happened and replay a
  delivery once the receiving endpoint is fixed.

## Architecture

```
                    ┌──────────────┐
  POST /v1/events   │              │   INSERT Event
 ──────────────────▶│   API (Express)│   INSERT Delivery (1 per matching
                    │              │    subscription)
                    └──────┬───────┘
                           │ enqueue
                           ▼
                    ┌──────────────┐
                    │ Redis (BullMQ)│
                    └──────┬───────┘
                           │
                           ▼
                    ┌──────────────┐      signed POST      ┌─────────────┐
                    │  Delivery     │ ─────────────────────▶│ Subscriber  │
                    │  Worker       │                        │ endpoint    │
                    └──────┬───────┘◀───────────────────────└─────────────┘
                           │  failure → re-enqueue with backoff
                           ▼
                    ┌──────────────┐
                    │  PostgreSQL   │  Delivery + DeliveryAttempt history
                    └──────────────┘
```

The API and worker are two separate processes sharing one codebase, scaled
independently — the API is stateless and scales on request volume, the
worker scales on delivery throughput.

## Project structure

```
api/
  src/
    modules/            # subscriptions, events, deliveries — each with
                         # routes.ts (HTTP layer) + service.ts (business logic)
    queue/               # BullMQ queue + worker (the delivery engine)
    lib/                 # signature signing/verification, errors, logging
    middleware/          # API key auth, centralized error handling
    __tests__/           # vitest: signature, backoff math, service logic
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
cp .env.example .env        # point at your Postgres/Redis
npm install
npx prisma migrate dev
npm run seed                 # prints a demo tenant API key
npm run dev                  # API on :3000
npm run worker:dev           # in a second terminal
```

```bash
cd web
npm install
npm run dev                  # dashboard on :5173, paste the API key when prompted
```

## Trying it via the API directly

```bash
# Create a subscription (the response includes the signing secret — save it)
curl -X POST http://localhost:3000/v1/subscriptions \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"targetUrl":"https://webhook.site/your-id","eventTypes":["order.created"]}'

# Publish an event — fans out to every matching subscription
curl -X POST http://localhost:3000/v1/events \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"type":"order.created","payload":{"orderId":"ord_123","amount":4200}}'
```

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

Covers signature signing/verification (including tamper and replay
rejection), the exponential backoff calculation, and subscription service
logic against a mocked Prisma client.

## What I'd add with more time

- Idempotency keys on `POST /v1/events` so a retried publish call can't
  double-fan-out
- Per-subscription delivery rate limiting, so one slow subscriber's queue
  depth can't starve others under the same tenant
- A `deliveries.stats` endpoint (success rate, p95 latency per subscription)
  for the dashboard
- Webhook payload schema registry so publishers get compile-time safety
