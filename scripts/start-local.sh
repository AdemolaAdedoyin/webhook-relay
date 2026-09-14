#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEY_FILE="$ROOT_DIR/.relay-api-key"

cd "$ROOT_DIR"

echo "Starting Relay with Docker Compose..."
docker compose up --build -d

if [[ -f "$KEY_FILE" ]]; then
  API_KEY="$(tr -d '\r\n' < "$KEY_FILE")"
else
  API_KEY="wr_$(openssl rand -hex 24)"
  printf '%s\n' "$API_KEY" > "$KEY_FILE"
  chmod 600 "$KEY_FILE" 2>/dev/null || true
fi

if [[ ! "$API_KEY" =~ ^wr_.{17,}$ ]]; then
  echo "Invalid local API key in $KEY_FILE; remove the file and run this script again." >&2
  exit 1
fi

echo "Preparing the reusable Demo Tenant..."
DEMO_API_KEY="$API_KEY" docker compose --profile tools run --rm seed >/dev/null

echo
echo "Relay is ready:"
echo "  Dashboard: http://localhost:5173"
echo "  API:       http://localhost:3000"
echo
echo "Demo tenant API key:"
echo "  $API_KEY"
echo
echo "The key is also stored locally in .relay-api-key (gitignored)."
echo "Use 'docker compose logs -f api worker' to follow backend activity."
