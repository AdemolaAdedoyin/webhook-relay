# Dashboard guide

Start locally with `bash scripts/start-local.sh`, open http://localhost:5173 and
connect using the printed demo admin key. Direct routes and refreshes work through
Nginx's SPA fallback. The browser calls the API directly; its address is compiled
into the web build through VITE_API_BASE_URL.

## Keys and permissions

A read/admin key is needed to browse data. Write actions require publish,
manage_subscriptions or replay scopes as documented in [API](API.md). Controls may
remain visible for a read-only key; the API rejects unauthorized changes and the
UI displays the error. The token is in sessionStorage until Disconnect or that
browser session ends; never use a shared browser for long-lived production access.
There is no dashboard key-management page or username/password login.

## Overview

- Retained events includes historical records and opens the list with historical
  records enabled.
- Active subscriptions counts only unarchived active records, with paused/disabled
  counts beneath it.
- Outstanding deliveries totals pending + processing + retrying and opens exactly
  those three selected statuses. Paused work is still outstanding.
- Failed deliveries opens failures. Needs attention links to failures/disabled
  receivers and warns about expired processing leases.

Counts refresh every 10 seconds and reflect retained records, not lifetime totals.
They do not prove a worker is alive or that a receiver's business logic succeeded.

## Subscriptions

Create a URL and event-type selection (blank means all types); save the signing
secret when it appears. Subscriptions are grouped by full URL and listed with
individual IDs, event selections, status, throughput and history links. Overlapping
selections at the same target are rejected. Existing duplicates are preserved.

Pause holds queued and new matching work; Resume continues it on reconciliation.
Reactivate a disabled target only after repairing it. Edit limits changes shared
concurrency/pacing. Rotate secret reveals the new key once with a five-minute
handover window. A request already started can still use the prior secret.

Archive is a retirement action with confirmation. It cancels pending/retrying work
and preserves read-only history, with no unarchive action. It cannot undo an
already-started HTTP request. Archived records are hidden by default: enable
Include archived to inspect them and follow View delivery history. Pause is the
correct choice if you plan to resume the same subscription.

## Events

Publish test event accepts an event type and JSON payload. It can create an event
with no matching subscriptions; later subscriptions do not automatically receive
that event. The UI publish form does not set an idempotency key; use the API for
idempotent publishing. Use synthetic data with public test receivers.

View event opens the payload, ID, timestamp, optional idempotency key and retained
delivery history. Include historical reveals events whose associated subscriptions
are all archived. Each delivery links to its attempt timeline. Events without
retained deliveries show an explanation rather than an unexplained empty list.
Older physical deletions cannot be reconstructed by the archive migration.

## Deliveries

Paste an Event ID and Apply event filter, select a subscription, and check one or
more statuses. No selected status means all statuses. Filters are kept in the URL;
Clear filters resets them. The newest 50 matching deliveries are displayed and
refresh every five seconds. There is no UI pagination yet.

Targets wrap, and Copy URL gives success/failure feedback. Paused pending/retrying
work is labelled Held. Click the event-type button to inspect the delivery: run,
attempt budget, payload, eligible time, errors and per-run attempt timeline.
Detail polls every three seconds. Response snippets are truncated and are not full
receiver responses. A recovered attempt may lack a response record after a crash.

Replay explains the duplicate-effect risk before confirmation. It is available
only for terminal succeeded/failed deliveries under the manual replay cap. The
UI shows used/maximum manual replays; archives and cancelled rows are read-only.
Replay starts a new run, whereas an automatic retry remains in the same run.

## Troubleshooting

- 401: reconnect with a valid non-revoked, unexpired key.
- 403: request the appropriate scope; switching screens does not grant access.
- Network/CORS error: check API readiness, exact configured browser origin and
  VITE_API_BASE_URL; rebuild the web image after changing its API URL.
- HTTP 409: inspect the message (duplicate subscription, conflicting idempotency
  key, replay already running/capped, or rotation still in grace).
- No progress: inspect worker logs and paused/disabled state. API readiness is not
  worker liveness. Backoff and pacing can delay eligible work.
- Deep-link 404 or OpenSSL startup warnings: rebuild the correct checkout; do not
  delete volumes as an image troubleshooting step.

Error messages include a request ID when supplied by the API. See
[Operations](OPERATIONS.md) for logs, backup and upgrade procedures.
