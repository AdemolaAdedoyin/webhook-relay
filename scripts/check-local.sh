#!/usr/bin/env bash
# Read-only checks against an already-started Compose stack. No seed or sends.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
for service in api worker web; do
  docker compose exec -T "$service" sh -c 'test "$(id -u)" != 0'
done
docker compose exec -T api node -e 'fetch("http://127.0.0.1:3000/ready").then(async r=>{if(!r.ok)throw Error("API not ready");const b=await r.json();console.log(JSON.stringify(b));}).catch(e=>{console.error(e.message);process.exit(1)})'
for route in overview subscriptions events deliveries; do
  docker compose exec -T web wget -q -O - "http://127.0.0.1:8080/$route" | grep '<div id="root">' >/dev/null
done
echo 'Local checks passed: API readiness, dashboard deep links, non-root API/worker/web.'
echo 'Worker execution and retry/recovery are covered by the integration suite; readiness alone does not prove delivery.'
