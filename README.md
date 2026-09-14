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
- **Crash recovery and graceful draining** — `PROCESSING` deliveries maintain a
  durable heartbeat. Stale leases are recovered into the next durable attempt,
  and SIGTERM/SIGINT stops reconciliation and lets active BullMQ jobs finish
  before Redis and PostgreSQL connections are closed.
- **At-least-once delivery with idempotent queue projection** — a background
  worker retries failed deliveries with exponential backoff + jitter, capped and
  bounded by a max attempt count, while stale queue projections are ignored.
- **Payload integrity** — outgoing payloads are HMAC-SHA256 signed with a
  per-subscription secret and a timestamp, so receivers can verify authenticity
  and reject replayed requests.
- **Failure isolation** — one subscriber's broken endpoint can't affect
  delivery to any other subscriber; exhausted failures increment the
  subscription failure counter atomically and sustained failure auto-disables it.
- **Full auditability** — completed network attempts are recorded by run and
  attempt, so an operator can see what happened and safely replay a delivery
  after the receiver is fixed.

## Architecture

```text
                    ┌──────────────┐
  POST /v1/events   │              │   INSERT Event
 ──────────────────▶│ API (Express)│   INSERT Delivery (1 per matching
                    │              │    subscription)
                    └──────┬───────┘
                           │ deterministic projection
                           ▼
                    ┌──────────────┐
                    │ Redis/BullMQ │◀──── reconciliation + stale recovery from Postgres
                    └──────┬───────┘
                           │
                           ▼
                    ┌──────────────┐      signed POST      ┌─────────────┐
                    │ Delivery     │ ─────────────────────▶│ Subscriber  │
                    │ Worker       │                        │ endpoint    │
                    └──────┬───────┘◀───────────────────────└─────────────┘
                           │ failure → persist retry + project next attempt
                           ▼
                    ┌──────────────┐
                    │ PostgreSQL   │  Delivery + DeliveryAttempt history
                    └──────────────┘
```

PostgreSQL is the durable source of truth for delivery state. Redis/BullMQ is
an execution layer that can be rebuilt from `PENDING` and `RETRYING` rows. Queue
jobs are scoped to a delivery `runNumber` + `attemptNumber`, and the worker uses
an atomic `PROCESSING` transition before making an outbound request. While an
attempt is active, the worker refreshes `processingHeartbeatAt`. If the lease
becomes stale, recovery fences the old run/attempt state and schedules the next
attempt. A manual replay increments the run number and resets only the current
run's retry budget; historical attempts remain available for audit/debugging.

Recovery intentionally preserves **at-least-once** semantics. If a worker dies
after the receiver accepted a request but before Relay durably finalized it, the
recovered attempt may deliver the event again. Receivers should therefore treat
`Webhook-Delivery-Id` + `Webhook-Delivery-Run` as the idempotency identity for a
logical delivery run.

The API and worker are separate processes sharing one codebase, so they can be
scaled independently.

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
subscription creation/delivery is disabled. Local Docker Compose explicitly runs
the API/worker in development mode so public test receivers such as webhook.site
can be used without configuring a production allowlist.

## Project structure

```text
api/
  src/
    modules/            # subscriptions, events, deliveries — HTTP + business logic
    queue/               # BullMQ projection, claims, lease recovery, reconciliation
    lib/                 # signatures, idempotency, network safety, errors, logging
    middleware/          # API key auth, centralized error handling
    scripts/seed.ts      # demo tenant/API-key seed utility
    __tests__/           # vitest: delivery lifecycle, recovery, security, services
  prisma/schema.prisma   # Tenant, Subscription, Event, Delivery, DeliveryAttempt
web/
  src/                   # React/Vite operations dashboard
  nginx.conf             # SPA fallback so /subscriptions etc. survive refreshes
scripts/
  start-local.sh         # one-command Docker startup + reusable demo API key
docker-compose.yml       # Postgres, Redis, migrator, API, worker, dashboard
```

## Local quickstart

The recommended local path is one command from the repository root:

```bash
bash scripts/start-local.sh
```

The script:

1. builds and starts Postgres, Redis, the one-off Prisma migrator, API, worker,
   and dashboard;
2. waits on the Compose dependency chain so migrations complete before the API
   and worker start;
3. creates or refreshes a reusable `Demo Tenant`;
4. generates a local `wr_...` API key on first run, stores it in the gitignored
   `.relay-api-key` file, and prints it each time you start the project.

After startup:

```text
Dashboard: http://localhost:5173
API:       http://localhost:3000
```

Paste the printed `wr_...` key into the dashboard's **Connect to Relay** screen.
The dashboard is a client-side React app; Nginx is configured with an SPA
fallback, so direct navigation or refreshes such as
`http://localhost:5173/subscriptions` continue to load the dashboard.

Useful local commands:

```bash
# Follow backend activity
docker compose logs -f api worker

# Check container state
docker compose ps

# Stop the stack without deleting Postgres data
docker compose down

# Reset everything including local Postgres data
docker compose down -v
```

If you specifically want to create/refresh the demo tenant yourself through the
Docker seeder utility, run:

```bash
DEMO_API_KEY="wr_your_local_key_here" docker compose --profile tools run --rm seed
```

The production runtime image intentionally does not contain `tsx` or the Prisma
CLI; migrations and seeding use dedicated Docker targets instead.

### Worker recovery tuning

The defaults are intentionally conservative for normal webhook request times:

```env
DELIVERY_PROCESSING_HEARTBEAT_MS=5000
DELIVERY_PROCESSING_STALE_MS=60000
```

The stale timeout must be greater than twice the heartbeat interval. A worker
refreshes the durable lease while it owns `PROCESSING`; once the lease is stale,
another worker may recover the delivery. The normal outbound request timeout is
configured separately with `DELIVERY_TIMEOUT_MS`.

### Running without Docker

With local PostgreSQL and Redis already running:

```bash
cd api
cp .env.example .env
npm install
npx prisma migrate dev
npm run seed
npm run dev
```

In a second API terminal:

```bash
npm run worker:dev
```

Then start the dashboard:

```bash
cd web
npm install
npm run dev
```

When running the seed locally rather than in Docker, make sure `api/.env`
contains a valid `DATABASE_URL`, for example:

```env
DATABASE_URL=postgresql://webhook_relay:webhook_relay@localhost:5432/webhook_relay
REDIS_URL=redis://localhost:6379
```

## End-to-end webhook smoke test

A simple manual test uses a temporary receiver such as webhook.site.

1. Start Relay with `bash scripts/start-local.sh` and connect the dashboard with
   the printed API key.
2. Create a subscription whose target is your unique webhook.site URL and whose
   event type is `order.created`. Save the signing secret when it is displayed;
   the full secret is intentionally shown only at creation time.
3. Publish an `order.created` event from the dashboard or API and confirm exactly
   one request arrives at the receiver.
4. Open the delivery and confirm `Run 1`, `Attempts 1 / 8`, and a successful
   `Run 1 · Attempt 1` history entry.
5. Replay the completed delivery. Exactly one additional request should arrive;
   the delivery should become `Run 2`, its current retry count should restart at
   `1 / 8`, and the Run 1 attempt should remain in history.

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

```text
Webhook-Signature: t=1699999999,v1=<hex hmac-sha256>
```

Recompute `HMAC-SHA256(secret, "${t}.${rawBody}")` and compare it to `v1`
using a constant-time comparison; reject requests whose `t` is more than a few
minutes old. See `api/src/lib/signature.ts` for the reference implementation.

## Tests

```bash
cd api && npm test
```

CI applies the committed Prisma migrations to a fresh PostgreSQL database, runs
the API test suite and TypeScript build, and builds the React dashboard.

## What I'd add with more time

- Per-subscription delivery rate limiting, so one slow subscriber's queue depth
  can't starve others under the same tenant.
- A `deliveries.stats` endpoint (success rate, p95 latency per subscription) for
  the dashboard.
- A webhook payload schema registry so publishers can validate event contracts.
