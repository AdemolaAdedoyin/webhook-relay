# API reference

Local base URL: `http://localhost:3000`. JSON request/response bodies unless noted.
The API and worker are separate processes; a healthy API alone does not prove
that deliveries are being executed. Start with the [local walkthrough](LOCAL-WALKTHROUGH.md).

## Authentication and conventions

Send `Authorization: Bearer <token>` to every `/v1` endpoint. Local startup prints
a reusable demo admin token. Production provisioning is described in
[Operations](OPERATIONS.md). Tokens are shown once on creation; database records
store only their SHA-256 hashes. Never put keys in query strings.

| Scope | Access |
| --- | --- |
| `admin` | All endpoints, including key administration |
| `read` | GET subscriptions, events, deliveries and operations/metrics |
| `publish` | POST events |
| `manage_subscriptions` | Create, pause/resume, archive, edit limits, rotate secrets |
| `replay` | POST delivery replay |

Scopes combine; `publish` alone does not grant read access. Invalid, expired or
revoked keys return 401; missing scope returns 403. Cross-tenant object IDs return
404. Unknown fields are not uniformly rejected, so send only documented fields.

All API responses disable caching. `X-Request-Id` is returned on normal requests;
a supplied identifier of 1–128 letters/digits/`.`/`_`/`-` is accepted, otherwise one
is generated. Include it when reporting a failure. Errors generally use:

```json
{"error":{"requestId":"...","code":"VALIDATION_ERROR","message":"Request failed validation","details":{}}}
```

| Status | Meaning |
| --- | --- |
| 400 / 413 / 415 | Invalid JSON / body over 1 MB / unsupported body encoding |
| 401 / 403 | Authentication / scope failure |
| 404 | Unknown route or tenant-owned object; archived limit updates also return 404 |
| 409 | Idempotency conflict, subscription overlap, rotation in progress, replay blocked/capped, archive restrictions |
| 422 | Request/query validation failure |
| 429 | Rate limit; currently 300 requests/minute per client IP per API process |
| 500 / 503 | Unexpected error / dependency readiness unavailable |

The rate-limit response is middleware-generated and may be plain text. The
in-memory limiter is not a distributed tenant quota. Health/readiness bypass it.
CORS only governs browsers; all clients still require authentication.

## Health and operations

| Method/path | Result |
| --- | --- |
| `GET /health` | 200 `{"status":"ok"}`; process liveness |
| `GET /ready` | 200 or 503, `status` plus `checks.postgres` / `checks.redis` |
| `GET /v1/operations` | `events`, subscription counts by status, delivery counts by status, `staleProcessing` |
| `GET /v1/operations/metrics` | Prometheus-format tenant-scoped gauges; requires read/admin |

Archived subscriptions are excluded from subscription counts. Delivery/event
counts describe retained records, not lifetime activity or a success rate.

## Subscriptions

| Method/path | Inputs / result |
| --- | --- |
| `POST /v1/subscriptions` | 201 subscription with one-time `secret` |
| `GET /v1/subscriptions` | Array, newest first; `includeArchived=true` includes archives |
| `GET /v1/subscriptions/:id` | One subscription, including archived records |
| `PATCH /v1/subscriptions/:id/status` | `{"status":"ACTIVE"}` or `{"status":"PAUSED"}` |
| `PATCH /v1/subscriptions/:id/limits` | One or both throughput fields below |
| `POST /v1/subscriptions/:id/rotate-secret` | `{"graceSeconds":300}`; one-time new secret and prior-key expiry |
| `DELETE /v1/subscriptions/:id` | 204; idempotent archive, **not physical deletion** |

Create body:

```json
{"targetUrl":"https://receiver.example.com/hooks","description":"Orders","eventTypes":["order.created"],"maxConcurrentDeliveries":2,"minDeliveryIntervalMs":0}
```

`targetUrl` is required. `description` is optional, at most 280 characters.
`eventTypes` defaults to `[]` (all events), is trimmed/deduplicated/sorted, and must
not contain blank types. `maxConcurrentDeliveries` is 1–100 (default 2), and
`minDeliveryIntervalMs` is 0–3600000 (default 0). Limits apply across workers;
changing them does not cancel active requests.

New subscriptions cannot overlap event types at the same normalized full URL
within a tenant. All-events overlaps every type. Fragments are ignored; paths and
query strings matter. Paused/disabled subscriptions reserve their selection;
archived ones do not. Older duplicates are retained rather than silently merged.

Targets allow only HTTP(S), without embedded credentials. Private, loopback,
metadata, reserved and transition addresses are blocked. DNS is checked again
inside the connection lookup, and only validated addresses reach the socket.
Production additionally requires an exact-host allowlist. Redirects are failures,
not followed. Use HTTPS receivers for real data.

Pause holds queued/retrying work and new matching events without spending attempts.
Resume makes backlog eligible on reconciliation (normally within 30 seconds),
subject to existing retry delays and throughput limits. Disabled subscriptions
receive no new fan-out and require explicit reactivation after fixing the receiver.
Archive cancels queued work, excludes future fan-out, and preserves history as
read-only. Already-claimed requests may finish. No unarchive endpoint exists.

Reads never return signing plaintext/ciphertext. Rotation grace is 0–3600 seconds,
default 300. Both current/previous signatures are sent during grace. A second
rotation during grace returns 409. Store the new secret at the receiver before
expiry. Archives reject rotation/status/limit changes.

## Events

| Method/path | Inputs / result |
| --- | --- |
| `POST /v1/events` | 202 `{event, deliveryCount, idempotentReplay}` |
| `GET /v1/events` | Array; `type`, `limit` (1–200, default 50), `includeHistorical=true` |
| `GET /v1/events/:id` | Payload, publication metadata, derived `historical`, associated deliveries and public subscription summaries |

Publish body: `{"type":"order.created","payload":{"orderId":"demo-001"}}`.
Type is 1–120 characters. Payload must be a JSON value. Active and paused matching
subscriptions receive durable delivery rows; paused rows wait. An event with no
matches is accepted with zero deliveries. Later subscriptions do not backfill it.

Optional `Idempotency-Key` is 1–200 characters after trimming, scoped to the tenant.
Repeat the same type/payload/key to return the original event without new fan-out.
Reuse a key for different content to get 409 `IDEMPOTENCY_CONFLICT`. Object-key
order is ignored; array order matters. Archive does not clear these records.

An event is Historical only when it has retained deliveries and all associated
subscriptions are archived. It is hidden by default but still accessible by ID.
Events with no deliveries remain visible. No event deletion, re-fan-out or automatic
retention endpoint exists. Lists expose `_count.deliveries`; detail includes history.

## Deliveries and replay

| Method/path | Inputs / result |
| --- | --- |
| `GET /v1/deliveries` | Array; optional `eventId`, `subscriptionId`, `status`, `limit` (1–200, default 50) |
| `GET /v1/deliveries/:id` | Event payload, target, status, run/attempts, response/error snippets, `replaysUsed`, `maxReplays` |
| `POST /v1/deliveries/:id/replay` | Raw updated delivery row, new PENDING run; no request body required |

`status` accepts a single value or comma-separated values: PENDING, PROCESSING,
RETRYING, SUCCEEDED, FAILED, CANCELLED. Filtering happens before the result limit.
There is currently no cursor pagination. Detail attempts are ordered by run and
attempt; archival retains them. Snippets are limited to 2000 response bytes.

Replay accepts only SUCCEEDED/FAILED unarchived deliveries. It increments
`runNumber`, clears the current result, resets attempt count, preserves attempt
history and starts a fresh run. `DELIVERY_MAX_REPLAYS` defaults to 5 manual replays
per delivery; 0 disables it. The initial run is not a replay. Concurrent requests
cannot spend the same slot. Errors include `DELIVERY_IN_FLIGHT`,
`DELIVERY_ARCHIVED` and `REPLAY_LIMIT_REACHED` (409). Each run's network-attempt
budget defaults to 8, separately configured by `DELIVERY_MAX_ATTEMPTS` at creation.

## API keys

| Method/path | Inputs / result |
| --- | --- |
| `POST /v1/keys` | 201 `{id,name,scopes,createdAt,expiresAt,revokedAt,token}`; token shown once |
| `GET /v1/keys` | Latest 200 records including revoked/expired keys, never hashes/tokens |
| `DELETE /v1/keys/:id` | 204; revoke, tenant scoped |

Create with `{"name":"Publisher","scopes":["publish"],"expiresAt":"2030-01-01T00:00:00.000Z"}`.
Name is 1–80 trimmed characters, scopes must be a nonempty supported list, and
optional expiry must be a future ISO timestamp. Verify a replacement before
revoking an admin key; the API permits revoking the final admin key.

## Receiver contract

Relay sends a JSON envelope, not the original payload alone:

```json
{"id":"event-id","type":"order.created","createdAt":"ISO timestamp","data":{"orderId":"demo-001"}}
```

Headers: `Webhook-Event-Type`, `Webhook-Delivery-Id`, `Webhook-Delivery-Run`,
`Webhook-Signature`, `Content-Type: application/json` and `User-Agent`.
Signature format is `t=<Unix milliseconds>,v1=<hex HMAC-SHA256>`; despite older
examples with short timestamps, the implementation uses **milliseconds**. Compute
HMAC over `${timestamp}.${exactRawBody}`, compare constant-time, and reject excessive
clock skew (reference helper defaults to five minutes). During rotation, accept
any valid `v1` digest. Use the raw body before JSON parsing/re-serialization.

Return any 2xx to acknowledge. Other responses and transport failures retry with
exponential backoff plus jitter (up to an hour). Do not infer exactly-once effects:
a receiver may accept a request just before a worker crashes. Deduplicate by
`Webhook-Delivery-Id` + `Webhook-Delivery-Run` for one logical run, or use the event
ID/business key if replays should not repeat business effects. Persist that decision
with the business operation before acknowledging.
