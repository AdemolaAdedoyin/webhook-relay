# Future deployment preparation (not a deployment recipe)

The supported setup remains local Docker Compose. No public deployment, TLS
endpoint, cloud resources or hosting credentials have been configured. Do not
expose the current Compose stack as a production service.

## Prepared and checked now

- API and worker use the Node image's non-root user; the dashboard uses Nginx's
  non-root user on container port 8080 (host port remains 5173).
- Application services have read-only root filesystems, writable temporary
  storage, dropped Linux capabilities, no privilege escalation and an init process.
- API readiness and dashboard health checks gate `up --wait`. The worker has no
  liveness endpoint; functional delivery is separately covered by integration tests.
- Application shutdown has a 30-second grace period with existing drain handling.
- Migrations run in a separate one-shot image before API/worker startup. The
  runtime excludes development tooling; demo seeding is an optional tools profile.
- Redis uses AOF and a named volume. PostgreSQL remains the durable source of
  delivery truth; Redis persistence does not replace database backups.
- All local ports bind to 127.0.0.1. Override host port numbers with API_PORT,
  WEB_PORT, POSTGRES_PORT and REDIS_PORT if defaults are occupied. Compose passes API_PORT to the web build's browser-facing API URL;
  rebuild the dashboard after changing it.
- CI builds and boots the actual images and checks readiness, deep routes and
  runtime user IDs. These checks do not certify production security or capacity.

## Decisions to make before public hosting

1. Choose a host, domain, TLS termination and network boundaries. Keep databases
   and Redis private, replace demo database passwords, restrict CORS to the
   dashboard origin, and review proxy trust/rate limits for that topology. Current
   CORS is permissive and local Compose deliberately runs NODE_ENV=development.
2. Set NODE_ENV=production, provision the same SIGNING_SECRET_KEY for API/worker,
   and configure exact WEBHOOK_ALLOWED_HOSTS. Back up the encryption key separately
   and securely. Follow the README encryption/backfill procedure for existing
   plaintext rows before starting production writers. Never use the demo seed as
   production account provisioning.
3. Build the web image with the actual browser-facing VITE_API_BASE_URL. This is a
   build-time value. Rebuild and smoke-test direct routes after changing it.
4. Select supported base-image versions/digests, scan dependencies and images,
   and establish an update cadence. Current image tags remain floating; lockfiles
   pin JavaScript dependency resolution but do not make base images immutable.
5. Choose resource limits, availability targets, retention and backup schedules.
   Monitor readiness, failed deliveries, stale leases, disabled subscriptions,
   database/Redis capacity and worker progress. Prove capacity with representative
   load instead of treating current defaults as a production guarantee.
6. Test upgrades and restore in a separate environment. Stop writers if required
   by schema/secret changes, back up the database, apply migrations once, then
   start compatible API and worker images. Verify a synthetic signed delivery,
   retry and replay before routing real traffic. Pin the previous image for
   rollback; schema changes may require forward fixes or a coordinated restore,
   rather than simply starting an older binary.

## Local backup example

This exports the current database without stopping it. Protect the resulting
file because it includes events and potentially plaintext local signing secrets.

```bash
mkdir -p backups
chmod 700 backups
(umask 077; docker compose exec -T postgres pg_dump -U webhook_relay \
  -d webhook_relay -Fc > "backups/relay-$(date +%Y%m%d-%H%M%S).dump")
```

A backup is only proven after a restore drill. Restore to a separate empty
PostgreSQL database using `pg_restore --no-owner --exit-on-error`, then inspect
row counts and run a controlled delivery test with isolated workers and receivers.
Do not restore over an active local database or start restored subscriptions that
would send real events unintentionally. Retain matching encryption keys for any
encrypted backups. Redis can be rebuilt through reconciliation but receiver-side
duplicate handling remains necessary after failures or restores.

## Deferred intentionally

Live hosting, TLS/proxy configuration, production CORS and secret provisioning,
managed databases, automated backups/restore drills, image digest pinning and
scanning, resource/load sizing, alert delivery and release automation. These are
future deployment work, not completed claims. The final audit is the remaining
roadmap phase and will review correctness and record outstanding limitations.
