# Local walkthrough

Relay is a local-first portfolio project. No cloud account or deployment is
required. Install Docker with Compose v2 supporting `up --wait`, plus Bash and
OpenSSL for the startup helper. Run commands from the repository root.

## Start and inspect

```bash
bash scripts/start-local.sh
bash scripts/check-local.sh
```

Open http://localhost:5173 and enter the printed demo key. The helper reuses the
key in `.relay-api-key`; keep that file private. Seeding refreshes demo admin
access, so use it only for your local demo. PostgreSQL and Redis use named volumes.
All published ports bind to loopback; other computers cannot connect directly.

The Overview shows retained event and delivery counts. It is not a worker
heartbeat monitor. The check script verifies dependency readiness, dashboard deep
links and non-root application users without creating subscriptions or sending
webhooks. API health can fail if PostgreSQL or Redis is unavailable.

## Demonstrate a delivery

Use a public HTTPS receiver you control (a temporary webhook.site inbox also
works). Only send synthetic payloads: the receiver can read the entire event.
Private addresses, localhost and Docker service names are intentionally rejected.
The integration suite uses a tightly scoped test receiver internally; the normal
app has no local-destination bypass.

1. In **Subscriptions**, create a receiver for `order.created`. Save the displayed
   signing secret; list/detail APIs will not return it again.
2. In **Events**, publish `order.created` with `{"orderId":"demo-001"}`.
3. Open its deliveries. In a normal successful run, expect one attempt, an HTTP
   success response and `SUCCEEDED`. Inspect the payload and attempt timeline.
4. Replay the finished delivery and confirm the warning. Expect a new run and
   preserved history. Replay deliberately sends again; the receiver must tolerate
   duplicates even without replay because delivery is at least once.
5. Edit throughput limits to demonstrate the per-subscription concurrency cap and
   minimum interval. Waiting for capacity does not consume a network attempt.
6. Pause a subscription to preserve history. Deletion removes its deliveries and
   attempts, but retains the original event, which may belong to other deliveries.

For a failure demo, use a receiver you control that returns HTTP 503, publish a
new event, and inspect retry timing and responses. Restore successful responses
and replay only after the run finishes. Repeated exhausted deliveries eventually
disable the subscription; fix the receiver before choosing **Reactivate**.

## Demonstrate idempotent publishing

```bash
RELAY_API_KEY="$(cat .relay-api-key)"
curl --fail-with-body http://localhost:3000/v1/events \
  -H "Authorization: Bearer $RELAY_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: walkthrough-order-001' \
  -d '{"type":"order.created","payload":{"orderId":"demo-001"}}'
```

Repeat the exact request: it returns the original event rather than creating
another fan-out. Change the payload while keeping the key: expect HTTP 409.
The dashboard publish form does not supply an idempotency key automatically.

## Explain the design in five minutes

- PostgreSQL commits the event and delivery intent before queue projection.
- Redis/BullMQ schedules work; reconciliation rebuilds missing eligible jobs.
- Atomic claims and durable run/attempt numbers fence duplicate execution.
- Worker heartbeats support recovery after a crash. An accepted request whose
  result was never saved can be sent again; this is not exactly-once delivery.
- HMAC signatures authenticate payloads. Receiver-side idempotency handles repeat
  effects. API keys are scoped and hashed; signing secrets support encryption.
- Per-subscription admission prevents a busy receiver monopolizing all workers.
- The dashboard exposes current state and retained attempt history for debugging.

## Verification and maintenance

The GitHub Actions workflow runs API unit/integration tests, both builds, and a
separate fresh Docker startup with the read-only checks. Integration tests cover
real HTTP retries, replay, recovery, admission limits and secret/key behavior.
See the README testing section for local integration commands. Tests use their
own database/Redis services; never point integration tests at data you care about.

```bash
docker compose logs --tail=100 api worker
docker compose ps
docker compose down             # preserves data
bash scripts/start-local.sh      # rebuild and restart
```

Updating an existing checkout requires preserving local edits first. A stale
image can cause Prisma/OpenSSL errors or Nginx deep-link 404s. Rebuild the checkout
you actually run; do not remove volumes to fix images. `docker compose down -v`
is an explicit destructive reset of both PostgreSQL and Redis data.

To inspect graceful shutdown, `docker compose stop worker` requests a drain with
30 seconds before Docker may force termination; `docker compose start worker`
resumes work. API readiness can remain healthy throughout because it does not
measure worker activity. Longer configured delivery timeouts need a longer stop
grace period. Crash recovery is exercised automatically by integration tests.
