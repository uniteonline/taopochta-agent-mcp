#!/usr/bin/env bash
set -euo pipefail

MCP_BASE_URL="${MCP_BASE_URL:-https://taopochta.ru/api/mcp}"
MCP_ENDPOINT="${MCP_ENDPOINT:-}"
MCP_USER_ID="${MCP_USER_ID:-$(date +%s)}"
MCP_CLIENT_ID="${MCP_CLIENT_ID:-}"
MCP_CLIENT_SECRET="${MCP_CLIENT_SECRET:-}"
MCP_ACCESS_TOKEN_TTL_SEC="${MCP_ACCESS_TOKEN_TTL_SEC:-}"
MCP_REFRESH_TOKEN_TTL_SEC="${MCP_REFRESH_TOKEN_TTL_SEC:-}"
MCP_TOKEN="${MCP_TOKEN:-}"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required for curl examples." >&2
  exit 1
fi

base_no_slash="${MCP_BASE_URL%/}"
if [[ "${base_no_slash}" == */api/mcp ]]; then
  MCP_API_BASE_URL="${base_no_slash%/api/mcp}"
  default_rpc_url="${base_no_slash}"
elif [[ "${base_no_slash}" == */mcp ]]; then
  MCP_API_BASE_URL="${base_no_slash%/mcp}"
  default_rpc_url="${base_no_slash}"
else
  MCP_API_BASE_URL="${base_no_slash}"
  default_rpc_url="${base_no_slash}/api/mcp"
fi

if [[ -n "${MCP_ENDPOINT}" ]]; then
  if [[ "${MCP_ENDPOINT}" =~ ^https?:// ]]; then
    MCP_RPC_URL="${MCP_ENDPOINT%/}"
  else
    MCP_RPC_URL="${MCP_API_BASE_URL%/}/${MCP_ENDPOINT#/}"
  fi
else
  MCP_RPC_URL="${default_rpc_url}"
fi

MCP_TOKEN_URL="${MCP_TOKEN_URL:-${MCP_API_BASE_URL%/}/api/mcp/token}"

if [[ -z "${MCP_TOKEN}" ]]; then
  if [[ -z "${MCP_CLIENT_ID}" || -z "${MCP_CLIENT_SECRET}" ]]; then
    echo "MCP_TOKEN is not set. Please set MCP_CLIENT_ID and MCP_CLIENT_SECRET." >&2
    exit 1
  fi

  token_body="$(jq -nc \
    --arg client_id "${MCP_CLIENT_ID}" \
    --arg client_secret "${MCP_CLIENT_SECRET}" \
    --argjson sub "${MCP_USER_ID}" \
    --arg ttl "${MCP_ACCESS_TOKEN_TTL_SEC}" \
    --arg refresh_ttl "${MCP_REFRESH_TOKEN_TTL_SEC}" \
    '{
      grant_type: "client_credentials",
      client_id: $client_id,
      client_secret: $client_secret,
      sub: $sub
    }
    + (if ($ttl | length) > 0 then { ttl_sec: ($ttl | tonumber) } else {} end)
    + (if ($refresh_ttl | length) > 0 then { refresh_ttl_sec: ($refresh_ttl | tonumber) } else {} end)')"

  token_resp="$(curl -sS "${MCP_TOKEN_URL}" \
    -H "content-type: application/json" \
    -d "${token_body}")"
  MCP_TOKEN="$(echo "${token_resp}" | jq -r '.access_token // empty')"
  if [[ -z "${MCP_TOKEN}" ]]; then
    echo "Failed to issue MCP token from ${MCP_TOKEN_URL}" >&2
    echo "Response: ${token_resp}" >&2
    exit 1
  fi
fi

export MCP_BASE_URL MCP_API_BASE_URL MCP_ENDPOINT MCP_RPC_URL MCP_TOKEN_URL MCP_USER_ID
export MCP_CLIENT_ID MCP_CLIENT_SECRET MCP_ACCESS_TOKEN_TTL_SEC MCP_REFRESH_TOKEN_TTL_SEC
export MCP_TOKEN

rpc() {
  local method="$1"
  local params_json="${2:-{}}"
  local id="${3:-1}"
  local body
  body="$(jq -nc --arg m "${method}" --argjson id "${id}" --argjson p "${params_json}" \
    '{jsonrpc:"2.0", id:$id, method:$m, params:$p}')"

  curl -sS "${MCP_RPC_URL}" \
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
echo "[env] MCP_API_BASE_URL=${MCP_API_BASE_URL}"
echo "[env] MCP_RPC_URL=${MCP_RPC_URL}"
echo "[env] MCP_TOKEN_URL=${MCP_TOKEN_URL}"
echo "[env] MCP_USER_ID=${MCP_USER_ID}"
echo "[env] MCP_CLIENT_ID=${MCP_CLIENT_ID:-<not-set>}"
