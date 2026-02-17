#!/usr/bin/env bash
set -euo pipefail

MCP_BASE_URL="${MCP_BASE_URL:-http://127.0.0.1:3000}"
MCP_ENDPOINT="${MCP_ENDPOINT:-/api/mcp}"
AUTH_TOKEN_SECRET="${AUTH_TOKEN_SECRET:-dev-secret}"
MCP_USER_ID="${MCP_USER_ID:-$(date +%s)}"
MCP_TOKEN="${MCP_TOKEN:-}"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required for curl examples." >&2
  exit 1
fi

if [[ -z "${MCP_TOKEN}" ]]; then
  if ! command -v node >/dev/null 2>&1; then
    echo "node is required to auto-generate MCP token." >&2
    exit 1
  fi
  MCP_TOKEN="$(node -e "
const crypto = require('crypto');
const sub = Number(process.env.MCP_USER_ID || 1);
const secret = process.env.AUTH_TOKEN_SECRET || 'dev-secret';
const now = Math.floor(Date.now()/1000);
const header = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
const payload = Buffer.from(JSON.stringify({sub,iat:now,exp:now+3600})).toString('base64url');
const sig = crypto.createHmac('sha256', secret).update(header + '.' + payload).digest('base64url');
process.stdout.write(header + '.' + payload + '.' + sig);
")"
fi

export MCP_BASE_URL MCP_ENDPOINT AUTH_TOKEN_SECRET MCP_USER_ID MCP_TOKEN

rpc() {
  local method="$1"
  local params_json="${2:-{}}"
  local id="${3:-1}"
  local body
  body="$(jq -nc --arg m "${method}" --argjson id "${id}" --argjson p "${params_json}" \
    '{jsonrpc:"2.0", id:$id, method:$m, params:$p}')"

  curl -sS "${MCP_BASE_URL}${MCP_ENDPOINT}" \
    -H "content-type: application/json" \
    -H "authorization: Bearer ${MCP_TOKEN}" \
    -d "${body}"
}

call_tool() {
  local tool_name="$1"
  local args_json="${2:-{}}"
  local id="${3:-1}"
  local params_json
  params_json="$(jq -nc --arg n "${tool_name}" --argjson a "${args_json}" '{name:$n, arguments:$a}')"
  rpc "tools/call" "${params_json}" "${id}"
}

echo "[env] MCP_BASE_URL=${MCP_BASE_URL}"
echo "[env] MCP_ENDPOINT=${MCP_ENDPOINT}"
echo "[env] MCP_USER_ID=${MCP_USER_ID}"

