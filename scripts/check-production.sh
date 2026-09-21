#!/usr/bin/env bash
# Build a disposable, loopback-only production-mode stack; never deploy externally.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
export COMPOSE_PROJECT_NAME="relay-production-smoke-$$"
export COMPOSE_FILE=compose.production.yml
export POSTGRES_PASSWORD="$(openssl rand -hex 24)"
export REDIS_PASSWORD="$(openssl rand -hex 24)"
export SIGNING_SECRET_KEY="$(openssl rand -hex 32)"
export BOOTSTRAP_API_KEY="wrk_$(openssl rand -hex 32)"
export BOOTSTRAP_TENANT_NAME="Production smoke test"
export API_PORT="${SMOKE_API_PORT:-53002}"
export WEB_PORT="${SMOKE_WEB_PORT:-55175}"
export PUBLIC_API_URL="http://localhost:$API_PORT"
export CORS_ORIGINS="http://localhost:$WEB_PORT"
export WEBHOOK_ALLOWED_HOSTS=example.com
export TRUST_PROXY_HOPS=0
cleanup() { docker compose down -v >/dev/null; }
trap cleanup EXIT
if ! docker compose up --build -d --wait --wait-timeout 180; then
  docker compose logs --tail=60
  exit 1
fi
bash scripts/check-local.sh
docker compose --profile tools run --rm bootstrap
docker compose exec -T -e SMOKE_TOKEN="$BOOTSTRAP_API_KEY" api node <<'JS'
(async () => {
  const base = 'http://127.0.0.1:3000';
  const headers = {Authorization: `Bearer ${process.env.SMOKE_TOKEN}`};
  const response = await fetch(base + '/v1/operations', {headers});
  if (response.status !== 200) throw Error('Provisioned key failed');
  const blocked = await fetch(base + '/v1/operations', {headers:{...headers, Origin:'https://untrusted.example'}});
  if (blocked.headers.has('access-control-allow-origin')) throw Error('CORS allowed untrusted origin');
  const allowed = await fetch(base + '/v1/operations', {headers:{...headers, Origin:process.env.CORS_ORIGINS}});
  if (allowed.headers.get('access-control-allow-origin') !== process.env.CORS_ORIGINS) throw Error('CORS rejected configured origin');
  if ((await fetch(base + '/v1/operations')).status !== 401) throw Error('Unauthenticated access');
  console.log('Production-mode auth, CORS and provisioning checks passed. No webhook was sent.');
})().catch(e => {console.error(e.message); process.exitCode=1;});
JS
if docker compose --profile tools run --rm bootstrap >/dev/null 2>&1; then
  echo 'Repeated provisioning unexpectedly succeeded' >&2; exit 1
fi
echo 'Production-mode smoke checks passed; disposable volumes will now be removed.'
