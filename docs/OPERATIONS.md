# Development and production operations

## Supported local workflow

Use Docker Compose v2 supporting `up --wait`, Bash and OpenSSL. No cloud account
is required. For host development, use Node 22.12+ (22.x) or Node 24, PostgreSQL 16
and Redis 7; CI and runtime images use Node 22.

```bash
bash scripts/start-local.sh
bash scripts/check-local.sh
docker compose logs --tail=100 api worker
```

The default stack uses development mode, demo database credentials, loopback-only
ports, and persistent PostgreSQL/Redis volumes. Restart with `docker compose down`
and the startup helper; `down -v` permanently removes local data. Demo seeding
refreshes demo admin access and is not production account provisioning.

For source development, start only databases with `docker compose up -d postgres
redis`, copy api/.env.example to api/.env, then run:

```bash
npm --prefix api ci
npm --prefix web ci
npm --prefix api run prisma:generate
npm --prefix api run prisma:deploy
npm --prefix api run seed
npm --prefix api run dev
# Separate terminals:
npm --prefix api run worker:dev
npm --prefix web run dev
```

The API commands that need api/.env must run with `cd api` (dotenv resolves from
the process cwd; npm --prefix scripts run in the package directory). The developer
web server defaults to localhost:5173 and the API to localhost:3000. Never expose
a development server publicly.

## Checks

```bash
npm --prefix api test
npm --prefix api run build
npm --prefix web run build
npm --prefix api audit
npm --prefix web audit

docker compose -f compose.integration.yml up -d --wait
DATABASE_URL=postgresql://relay:relay@127.0.0.1:55432/relay_test npm --prefix api run prisma:deploy
INTEGRATION_DATABASE_URL=postgresql://relay:relay@127.0.0.1:55432/relay_test \
INTEGRATION_REDIS_URL=redis://127.0.0.1:56379/15 npm --prefix api run test:integration
docker compose -f compose.integration.yml down

bash scripts/check-production.sh
```

Integration tests use only dedicated *_test and Redis /15 instances and reset test
queue data. The production check builds a disposable loopback-only stack with
random test credentials, validates migrations/auth/CORS/non-root/readiness/deep
links, and removes **its own** volumes. It sends no external webhook and is not a
deployment. Alternate smoke ports: SMOKE_API_PORT and SMOKE_WEB_PORT.

## Production-mode template

`compose.production.yml` is a separate single-host template, not an override for
local Compose. It has isolated volumes, database/Redis passwords, Redis AOF with
noeviction, non-root/read-only application containers and fail-fast required
configuration. Database and Redis ports are not published. API/web publish only
on loopback for a host TLS reverse proxy. It is not an HA cluster or automatic
public hosting.

1. Copy `.env.production.example` to `.env.production`, protect it with chmod 600,
   and replace every blank/example value. Generate independent hex passwords and
   encryption key with `openssl rand -hex 32`. Retain a secure backup of the
   encryption key; losing it makes encrypted signing secrets unreadable.
2. Configure actual PUBLIC_API_URL, exact CORS_ORIGINS and exact receiver hostnames
   in WEBHOOK_ALLOWED_HOSTS. CORS is not authentication. Browser origins include
   scheme/port and no trailing slash/path. Use HTTPS for public traffic.
3. Select a host/domain/TLS reverse proxy. Restrict direct API access and set
   TRUST_PROXY_HOPS only for a fixed trusted topology. A wrong hop count can let a
   client spoof its source IP and evade rate limits. Default 0 trusts no proxy.
4. Build/migrate/start with the command below. For existing plaintext signing
   secrets, follow the README encryption backfill procedure before production
   writers start; do not simply point a production worker at a development DB.

```bash
docker compose --env-file .env.production -f compose.production.yml up --build -d --wait
```

To provision a **new** tenant, put a descriptive BOOTSTRAP_TENANT_NAME and a token
of `wrk_` plus `openssl rand -hex 32` in the protected environment file. Save the
token in your secret manager, then run:

```bash
docker compose --env-file .env.production -f compose.production.yml --profile tools run --rm bootstrap
```

Provisioning is create-only: the same token cannot reset or revive existing keys.
Only a hash is stored; the command does not print the token. Remove bootstrap
values from the file afterward. Issue scoped replacements via /v1/keys. This is
operator provisioning, not public registration. Protect Docker/host access because
container environments contain secrets.

## Configuration

| Variable | Default / requirement |
| --- | --- |
| NODE_ENV | development by default; template sets production |
| PORT | 3000, range 1–65535 |
| DATABASE_URL / REDIS_URL | Required; authenticated URLs in production template |
| SIGNING_SECRET_KEY | Required in production, 64 hex characters shared by API/worker |
| CORS_ORIGINS | Required in production, comma-separated exact HTTP(S) origins |
| WEBHOOK_ALLOWED_HOSTS | Exact receiver hostnames; production delivery fails closed when empty |
| TRUST_PROXY_HOPS | 0; configure only for known proxy topology |
| DELIVERY_MAX_ATTEMPTS | 8, persisted on new deliveries |
| DELIVERY_MAX_REPLAYS | 5, API-wide lifetime cap; 0 disables manual replay |
| DELIVERY_TIMEOUT_MS | 10000 |
| DELIVERY_CONCURRENCY | 10 worker jobs per process |
| DELIVERY_PROCESSING_HEARTBEAT_MS / STALE_MS | 5000 / 60000; stale must exceed twice heartbeat |
| SUBSCRIPTION_AUTO_DISABLE_THRESHOLD | 5 exhausted deliveries |
| LOG_LEVEL | info |
| VITE_API_BASE_URL / PUBLIC_API_URL | Browser-facing API URL, compiled at web build |

Compose templates explicitly wire common settings. To tune other worker variables,
add them to both appropriate service environments; a host environment variable is
not automatically forwarded into a container. Keep stop grace longer than request
timeouts and allow time for database finalization. Default stop grace is 30 seconds.

## Upgrade, backup and recovery

Record the deployed commit/image, preserve local edits, back up PostgreSQL and the
matching encryption key, and apply migrations once before new API/worker binaries
start. Keep API and workers on the same release. Review schema compatibility before
rolling back: old binaries may not understand new enum values. Restoring the DB is
a coordinated recovery action, not a normal rollback shortcut.

```bash
mkdir -p backups
chmod 700 backups
(umask 077; docker compose exec -T postgres pg_dump -U webhook_relay \
  -d webhook_relay -Fc > "backups/relay-$(date +%Y%m%d-%H%M%S).dump")
```

For the production stack use the same `--env-file`/`-f` arguments. Dumps contain
payloads and encrypted or development plaintext secrets. Test restores into a
separate empty DB with `pg_restore --no-owner --exit-on-error`, isolated workers
and controlled receivers before trusting a backup. Never resume restored real
subscriptions blindly: at-least-once effects may repeat. Redis can be reconstructed
from durable eligible rows, but is still persisted for normal recovery.

Watch API readiness, worker process state, failed deliveries, stale leases,
disabled receivers and database/Redis capacity. Tenant /operations/metrics exposes
gauges; there is no global cross-tenant metrics endpoint. Configure external alerts
and log retention in the chosen environment. Do not log tokens or payloads; receiver
error snippets may still contain sensitive data and are visible to read-scoped keys.

## Public launch gates

The repository supplies a tested production-mode runtime, not an assurance about
an unspecified host. Before real traffic, validate TLS, firewall/egress policy,
secrets storage and rotation, backups and restore drill, proxy trust, image scanning
and digest pinning, monitoring/alerts, capacity/load and retention requirements.
The in-memory rate limiter is per-process, list pagination is limited, and there is
no automated data purge or HA topology. See [Final audit](FINAL-AUDIT.md).
