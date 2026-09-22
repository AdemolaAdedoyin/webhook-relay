# Final audit

Scope: merged PR #14 plus the final-audit changes. Reviewed API routes, tenant and
scope boundaries, archive/pause/replay lifecycle, worker transport/recovery,
container startup and shutdown, dashboard behavior and operational documentation.
No public deployment was performed. This is an engineering audit, not an
independent penetration test or a certification of an unspecified hosting setup.

## Findings addressed

| Finding | Resolution |
| --- | --- |
| DNS could change between validation and the HTTP client's lookup | Validate DNS inside the socket lookup and connect directly to that address; reject mixed unsafe answers, reserved/transition ranges and redirects. |
| Reconciliation repeatedly selected the first 1,000 eligible rows | Advance a keyset cursor across passes and wrap after the last page. |
| API maintenance could overlap; shutdown did not drain all resources | Serialize maintenance, stop accepting HTTP requests and close queue, Redis and Prisma with a bounded shutdown deadline. |
| Production browser/proxy behavior lacked explicit configuration | Require exact CORS origins, validate proxy hop count, disable framework header and prevent API response caching. |
| Malformed/oversized JSON reached generic server errors | Return bounded 400/413/415 client errors without logging the submitted body. |
| Dependency audit advisories in runtime and tooling trees | Refresh lockfiles and upgrade Vite, Vitest and React Router; rebuild and retest. |
| Production bootstrap depended on demo seeding | Add create-only tenant provisioning and a separate authenticated production-mode Compose template. |
| Documentation mixed earlier phase behavior with current lifecycle | Add API, dashboard and operations references; correct README signature timestamp, controls and readiness guidance. |

PR #14's archive behavior retains audit/idempotency records; it does not erase
subscriptions, events or delivery attempts. Historical event classification is
derived. True pause/resume, overlapping-subscription rejection, multi-status
filters and the lifetime manual replay cap remain in place.

## Verification

- 42 unit tests pass, including connection-time DNS rejection and reconciliation
  beyond a full 1,000-row page.
- 21 real PostgreSQL/Redis/HTTP integration tests pass: publication/idempotency,
  signed delivery, retries, archive/replay races, lease recovery, scoped access,
  malformed and oversized request handling, and worker draining.
- API TypeScript and dashboard production builds pass with the upgraded tooling.
- Both npm dependency audits report zero known vulnerabilities at audit time.
  This is a point-in-time dependency check, not an image or application pentest.
- Disposable default and production-mode Compose checks cover migrations,
  readiness, non-root application containers and dashboard deep links.
- Manual browser checks on the built local dashboard pass: API-key connection,
  overview, combined outstanding-status filters, subscription page, event publishing
  without a receiver, and retained event details. This is not exhaustive browser coverage.
- Production-mode smoke additionally verifies authentication, allowed/disallowed
  CORS origins and create-only provisioning. It uses generated test secrets,
  publishes only loopback ports and removes its own test volumes.

CI runs unit/integration/build checks and both container smoke workflows. See
[Operations](OPERATIONS.md) for reproducible commands and [UI](UI.md) for the
interactive walkthrough. Test receivers are isolated; production destination
validation is never relaxed for real traffic.

## Documented deferrals and launch gates

Local development is supported. The production-mode template supplies a tested
single-host runtime; public hosting still requires environment-specific work:

- TLS/domain/reverse proxy, firewall and outbound network policy, correct proxy
  trust, and secure storage/rotation of credentials and encryption keys.
- Backup restoration rehearsal, monitoring/alerts, log retention and load testing
  against expected traffic; image scanning and immutable image pinning.
- Full pagination (current lists have bounded latest-record limits), automated
  retention/purge, shared multi-replica API rate limits, and HA infrastructure.
- A maintained browser end-to-end suite and broader crash/failure injection.
- Automated encryption master-key rewrapping and receiver schema contracts.

Delivery remains at-least-once. Receivers must handle duplicates; recovery cannot
prove whether a request completed before a worker crashed. Archiving cannot retract
an already-started request. Retained data and receiver response snippets require
appropriate access controls. No automatic event re-fan-out or unarchive exists.
