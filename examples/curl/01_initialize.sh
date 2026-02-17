#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

echo "== initialize =="
rpc "initialize" '{
  "protocolVersion": "2025-03-26",
  "capabilities": {},
  "clientInfo": { "name": "curl-example", "version": "1.0.0" }
}' 1 | jq .

echo "== notifications/initialized =="
rpc "notifications/initialized" '{}' 2 | jq .

