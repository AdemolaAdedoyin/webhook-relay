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


## Integration tests

`cd api && npm test` runs the fast unit suite without external services.
`npm run test:integration` separately exercises real PostgreSQL migrations and
constraints, Redis/BullMQ jobs, the Express API, delivery worker, and a real HTTP
receiver. CI runs both suites and fails on either failure.

For a local run, from the repository root:

```bash
docker compose -f compose.integration.yml up -d --wait
cd api
export INTEGRATION_DATABASE_URL="postgresql://relay:relay@127.0.0.1:55432/relay_test"
export INTEGRATION_REDIS_URL="redis://127.0.0.1:56379/15"
npm ci
npm run prisma:generate
DATABASE_URL="$INTEGRATION_DATABASE_URL" npm run prisma:deploy
npm run test:integration
cd ..
docker compose -f compose.integration.yml down
```

The test stack uses separate ports and ephemeral storage, so it does not reuse
or modify the demo stack. Use dedicated test services: the suite clears the
`webhook-deliveries` queue in Redis database 15 before starting and deletes its
own generated tenant after draining. Configuration requires a database name
ending in `_test` and Redis database `/15` to catch accidental default URLs.

Coverage includes concurrent idempotent publishing, signed delivery and replay
history, rejection of conflicting idempotency keys, stale queue jobs, repair of
missing queue projections, HTTP failure/retry, concurrent stale-claim recovery,
exhausted recovery without subscriber penalties, lease refresh, and draining an
active HTTP request during shutdown.

The test harness permits only its own ephemeral loopback receiver origin through
an in-memory replacement of outbound destination validation. No production
allowlist or SSRF rules are relaxed. All HTTP transport, signature handling,
database and queue operations are real. Destination security is tested separately
in the unit suite. Abandoned claims are seeded in PostgreSQL rather than created
by killing a worker process; these tests do not claim to cover OS-level signal
forwarding, Docker crash behavior, or the browser UI.

## Observability

Every API response carries `X-Request-Id`. A supplied ID is accepted only when it
contains 1–128 letters, digits, dots, underscores or hyphens; otherwise the API
generates a UUID. The same ID appears in HTTP logs and centralized error
responses. Access logs omit request headers, query strings and bodies so bearer
keys, cookies and payloads are not recorded. The ID is exposed to browser clients
through CORS. It correlates API requests, not subsequent asynchronous deliveries;
worker logs use delivery ID, run number and attempt number.

| Endpoint | Access | Meaning |
| --- | --- | --- |
| `GET /health` | Public | Process liveness; does not query dependencies. |
| `GET /ready` | Public | PostgreSQL `SELECT 1` and Redis `PING`; 200 when both pass, otherwise 503. |
| `GET /v1/operations` | Tenant bearer key | Retained event count, subscription/delivery counts by status, and stale processing count. |
| `GET /v1/operations/metrics` | Tenant bearer key | The same durable counts in Prometheus text exposition format. |

Readiness probes run concurrently with a 1.5-second response deadline per
request. Redis probes use a separate bounded connection rather than BullMQ's
retry-forever connection. A stalled database probe is reused until it settles,
preventing repeated probes from accumulating database work. Readiness reports
only boolean dependency status, not connection strings or internal errors.
Liveness/readiness bypass the tenant traffic rate limiter. These endpoints do
not prove that a separate worker process is running; monitor backlog and stale
processing counts as well.

Operations reads use one PostgreSQL repeatable-read snapshot scoped to the
request's tenant. Thus they reflect all worker replicas and remain meaningful
after an API restart. Metrics are **gauges of retained rows**, not lifetime
counters: replay changes a delivery's current state and deletion lowers counts.
Only fixed status enums are used as labels; no payloads, targets, tenant IDs or
secrets appear in metrics. No global BullMQ queue totals are exposed to tenants.

```bash
curl http://localhost:3000/ready
curl http://localhost:3000/v1/operations \
  -H "Authorization: Bearer $RELAY_API_KEY"
curl http://localhost:3000/v1/operations/metrics \
  -H "Authorization: Bearer $RELAY_API_KEY"
```

Scrape once per tenant with its bearer credential; add a stable tenant identifier
as a **scraper-side** target label if collecting multiple tenants. Counts require
database aggregation, so use a moderate scrape interval (for example 30 seconds)
and avoid high-frequency polling. A growing `RETRYING` backlog suggests receiver
failures; `relay_stale_processing > 0` indicates expired worker leases pending
recovery. Inspect delivery details and worker logs before replaying work. This
phase does not add request-rate histograms or a global administrative metrics
surface.

## Remaining roadmap

After phase 11 (dashboard polish):
12. Production runtime and deployment.
13. Final documentation and portfolio walkthrough.
14. Final full audit and documented deferrals.

## Per-subscription throughput

Each subscription now has two controls, accepted on creation or updated through
`PATCH /v1/subscriptions/:id/limits` with its tenant bearer key:

| Field | Default | Allowed range | Meaning |
| --- | --- | --- | --- |
| `maxConcurrentDeliveries` | 2 | 1–100 | Maximum durable `PROCESSING` deliveries across all worker replicas. |
| `minDeliveryIntervalMs` | 0 | 0–3,600,000 | Minimum spacing between admitted attempt starts; zero disables pacing. |

```bash
curl -X PATCH "http://localhost:3000/v1/subscriptions/$SUBSCRIPTION_ID/limits" \
  -H "Authorization: Bearer $RELAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"maxConcurrentDeliveries":2,"minDeliveryIntervalMs":500}'
```

A 500 ms interval admits at most two starts per second without a burst bucket.
This spaces **admission**, not receiver arrival times (DNS/network delays can
vary). The existing `DELIVERY_CONCURRENCY` remains a per-worker global ceiling;
subscription limits are shared across replicas. API validation and database
constraints enforce the ranges. Omitted update fields retain their values, and
empty/unknown-field patches are rejected. Other tenants cannot update a limit.

Workers lock the subscription row in a short PostgreSQL transaction, check the
current active count and pacing deadline using the database clock, and claim the
durable attempt before releasing the lock. Only a successful claim advances the
pacing deadline. The same admission applies to initial sends, retries and replay.
There is no separate Redis semaphore to lose during a Redis restart.

When capacity is unavailable, the worker persists `nextAttemptAt` and moves the
BullMQ job to delayed state, releasing its worker slot. `attemptCount`, run number,
and historical attempts remain unchanged. Concurrency waits are revisited after
about one second; pacing and retry deadlines are also honored. If that queue
transition fails, normal reconciliation repairs the durable intent. This permits
other subscriptions to progress while one endpoint is slow or capped; it is
best-effort fairness, not strict round-robin ordering or a latency SLA under an
arbitrarily large backlog.

Lowering limits does not cancel active HTTP requests. Existing pacing deadlines
and delayed jobs may still apply until their next check. Stale `PROCESSING` rows
occupy capacity until lease recovery releases them. As elsewhere in Relay,
recovery is at-least-once: an old process whose lease was recovered can still have
an uncertain external HTTP outcome. Durable concurrency limits are not an
exactly-once network guarantee.

Rollout: apply migrations before starting the new API/worker, and drain old worker
replicas before enabling new ones. Older worker code does not enforce these
controls. Existing subscriptions receive the default cap of two and no pacing.
The dashboard can read these fields through subscription APIs; editing controls
in the dashboard is reserved for the dashboard-polish phase.

## API-key lifecycle and scopes

Existing tenant keys are migrated into the new `ApiKey` table as admin keys, so
existing dashboard connections continue working after migrations. Authentication
now consults only `ApiKey` records: changing the historical `Tenant.apiKeyHash`
field does not bypass revocation. The demo seeder creates/refreshes an admin key;
run it only for local bootstrap or deliberate recovery. It may reactivate its
supplied demo key and does not revoke other keys.

| Scope | Access |
| --- | --- |
| `admin` | All endpoints, including issuing/listing/revoking API keys. |
| `read` | Read subscriptions, events, deliveries, operations and metrics. |
| `publish` | Publish events. |
| `manage_subscriptions` | Create/change/delete subscriptions and rotate signing secrets. |
| `replay` | Replay deliveries. |

Scopes are combined explicitly (for example `read` + `publish`). `admin` can
issue other admin keys; narrower keys cannot issue credentials or elevate their
permissions. Bearer tokens are hashed with SHA-256 at rest, checked for expiry and
revocation on every request, and returned only once on creation. In-flight API
requests already authorized before revocation may finish.

```bash
curl -X POST http://localhost:3000/v1/keys \
  -H "Authorization: Bearer $RELAY_API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"event producer","scopes":["publish"]}'
# Optional expiresAt: a future ISO-8601 UTC timestamp.
curl http://localhost:3000/v1/keys -H "Authorization: Bearer $RELAY_API_KEY"
curl -X DELETE "http://localhost:3000/v1/keys/$KEY_ID" \
  -H "Authorization: Bearer $RELAY_API_KEY"
```

Create and verify a replacement before revoking an old key. Self-revocation is
allowed; revoking the last admin key requires operator recovery. Key lists are
limited to the latest 200 records and never expose tokens/hashes. Authenticated
requests without a required scope receive 403; invalid/expired/revoked credentials
receive 401. Use TLS for all non-local API traffic.

## Signing-secret encryption and rotation

Production requires `SIGNING_SECRET_KEY`, a 64-character hex encoding of 32 random
bytes, shared by API and worker processes. For example, generate it with
`openssl rand -hex 32` and store it in your deployment secret manager, outside the
repository and database. Keep a recoverable backup: losing it makes stored signing
secrets unreadable. Development supports plaintext when no key is configured;
setting the key enables encryption locally too. Local Compose forwards the
variable to API, worker and tooling services.

New/rotated secrets use AES-256-GCM with a random nonce and subscription ID as
associated data. Ciphertext cannot be moved between subscriptions undetected.
API reads (including nested event details) expose neither plaintext nor ciphertext
nor previous keys. Creation and rotation return the new plaintext once.

For existing production data: stop API/worker writers, apply migrations, provide
the encryption key, then run `npm run secrets:encrypt` from the API tooling image
(or `api/` with its environment configured). It validates existing ciphertext and
backfills plaintext current/previous secrets in batches without printing secrets.
Only then start production API/workers with the same key. Production delivery
rejects plaintext secrets. Back up the database and key before this rollout.
Changing the encryption key is **not** signing-key rotation: changing it without
re-encrypting existing ciphertext with the old key makes delivery fail. Automated
master-key rewrapping/KMS integration is deferred.

```bash
curl -X POST "http://localhost:3000/v1/subscriptions/$SUBSCRIPTION_ID/rotate-secret" \
  -H "Authorization: Bearer $RELAY_API_KEY" -H "Content-Type: application/json" \
  -d '{"graceSeconds":300}'
```

During the grace period (default 300 seconds, maximum 3600), outgoing headers
contain the same timestamp with two `v1` signatures: current and previous. A
receiver should accept **any valid v1 digest** for its configured key, using the
exact raw body and timestamp tolerance. The exported `verifySignature` supports
this format. Install the returned new secret at the receiver before grace expires.
After expiry only the new key signs outgoing requests. A second rotation during
an active grace window returns 409. Zero grace is immediate cutover.

Already-started attempts can still use their captured old key; allow for the
request timeout/in-flight window when cutting over. Previous encrypted material
is not used after expiry and is overwritten at the next rotation; it is not
immediately erased from backups or stored rows. Existing plaintext backups still
need the same access protections as before.

## Docker troubleshooting: old checkouts

If API logs mention Alpine/OpenSSL 1.1, or a direct dashboard route returns an
Nginx 404, check `git log -1` and `git status` first. These fixes require the phase 5
Dockerfile and Nginx configuration or later. Update the checkout you actually
build, preserving local edits, then run `docker compose up -d --build`. Current
images use Debian/OpenSSL for Prisma, a separate migration service, and Nginx's
SPA fallback. Do not delete database volumes to fix an outdated image. Verify
`/ready` and `/deliveries` return 200 after the rebuild. Docker contexts now omit
host node_modules, build output and local environment files.

## Dashboard operations

The Overview page refreshes tenant counts every 10 seconds and links to failed
deliveries and subscriptions needing attention. Counts cover retained records;
they do not establish worker liveness. Deliveries refresh every 5 seconds, with
URL-preserved status, subscription and event filters applied server-side before
the latest-50 limit. Details refresh every 3 seconds and show payloads, attempt
history across replay runs, response snippets, errors and next eligible starts.

Replay requires confirmation because the receiver may already have processed
the event. Subscription controls support throughput limits, pause/resume,
reactivation and signing-secret rotation with a five-minute grace period. Save
the new secret at the receiver before that period expires. Deleting a subscription
removes its deliveries and attempts, while original events remain; pause instead
to retain history. Errors include request IDs when the API supplies them.

Connect with an admin or read-enabled key; write controls require their respective
scopes and display permission errors if unavailable. The key remains in browser
session storage until disconnected. Lists are limited to the latest 50 records;
full pagination and dashboard key administration remain deferred.
