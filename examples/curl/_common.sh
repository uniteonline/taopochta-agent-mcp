#!/usr/bin/env bash
set -euo pipefail

MCP_BASE_URL="${MCP_BASE_URL:-https://taopochta.ru/api/mcp}"
MCP_ENDPOINT="${MCP_ENDPOINT:-}"
MCP_USER_ID="${MCP_USER_ID:-$(date +%s)}"
MCP_BOOTSTRAP_EMAIL="${MCP_BOOTSTRAP_EMAIL:-${MCP_AGENT_EMAIL:-}}"
MCP_BOOTSTRAP_TOKEN="${MCP_BOOTSTRAP_TOKEN:-}"
MCP_ACCESS_TOKEN_TTL_SEC="${MCP_ACCESS_TOKEN_TTL_SEC:-}"
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

MCP_BOOTSTRAP_REQUEST_URL="${MCP_BOOTSTRAP_REQUEST_URL:-${MCP_API_BASE_URL%/}/api/mcp/bootstrap/email/request}"
MCP_BOOTSTRAP_EXCHANGE_URL="${MCP_BOOTSTRAP_EXCHANGE_URL:-${MCP_API_BASE_URL%/}/api/mcp/bootstrap/email/exchange}"

decode_jwt_sub() {
  local token="$1"
  local payload
  payload="$(printf '%s' "${token}" | cut -d'.' -f2 | tr '_-' '/+')"
  local mod=$(( ${#payload} % 4 ))
  if [[ ${mod} -eq 2 ]]; then
    payload="${payload}=="
  elif [[ ${mod} -eq 3 ]]; then
    payload="${payload}="
  elif [[ ${mod} -eq 1 ]]; then
    payload="${payload}==="
  fi
  printf '%s' "${payload}" | base64 -d 2>/dev/null | jq -r '.sub // empty'
}

if [[ -z "${MCP_TOKEN}" ]]; then
  if [[ -z "${MCP_BOOTSTRAP_TOKEN}" && -n "${MCP_BOOTSTRAP_EMAIL}" ]]; then
    request_body="$(jq -nc --arg email "${MCP_BOOTSTRAP_EMAIL}" '{email: $email}')"
    request_resp="$(curl -sS "${MCP_BOOTSTRAP_REQUEST_URL}" \
      -H "content-type: application/json" \
      -d "${request_body}")"
    echo "[auth] bootstrap request response: ${request_resp}"
    if [[ -t 0 ]]; then
      read -r -p "[auth] Paste bootstrap token from email (mbt_...): " MCP_BOOTSTRAP_TOKEN
    fi
  fi

  if [[ -n "${MCP_BOOTSTRAP_TOKEN}" ]]; then
    exchange_body="$(jq -nc \
      --arg bootstrap_token "${MCP_BOOTSTRAP_TOKEN}" \
      --arg ttl "${MCP_ACCESS_TOKEN_TTL_SEC}" \
      '{ bootstrap_token: $bootstrap_token }
      + (if ($ttl | length) > 0 then { ttl_sec: ($ttl | tonumber) } else {} end)')"
    exchange_resp="$(curl -sS "${MCP_BOOTSTRAP_EXCHANGE_URL}" \
      -H "content-type: application/json" \
      -d "${exchange_body}")"
    MCP_TOKEN="$(echo "${exchange_resp}" | jq -r '.access_token // empty')"
    if [[ -z "${MCP_TOKEN}" ]]; then
      echo "Failed to exchange bootstrap token at ${MCP_BOOTSTRAP_EXCHANGE_URL}" >&2
      echo "Response: ${exchange_resp}" >&2
      exit 1
    fi
    echo "[auth] obtained MCP token by bootstrap exchange."
  else
    echo "MCP_TOKEN is not set. Please provide MCP_BOOTSTRAP_EMAIL (+ MCP_BOOTSTRAP_TOKEN)." >&2
    exit 1
  fi
fi

decoded_sub="$(decode_jwt_sub "${MCP_TOKEN}")"
if [[ -n "${decoded_sub}" && "${decoded_sub}" =~ ^[0-9]+$ ]]; then
  MCP_USER_ID="${decoded_sub}"
fi

export MCP_BASE_URL MCP_API_BASE_URL MCP_ENDPOINT MCP_RPC_URL MCP_USER_ID
export MCP_ACCESS_TOKEN_TTL_SEC
export MCP_BOOTSTRAP_EMAIL MCP_BOOTSTRAP_TOKEN MCP_BOOTSTRAP_REQUEST_URL MCP_BOOTSTRAP_EXCHANGE_URL
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
echo "[env] MCP_BOOTSTRAP_REQUEST_URL=${MCP_BOOTSTRAP_REQUEST_URL}"
echo "[env] MCP_BOOTSTRAP_EXCHANGE_URL=${MCP_BOOTSTRAP_EXCHANGE_URL}"
echo "[env] MCP_USER_ID=${MCP_USER_ID}"
echo "[env] MCP_BOOTSTRAP_EMAIL=${MCP_BOOTSTRAP_EMAIL:-<not-set>}"
echo "[env] MCP_BOOTSTRAP_TOKEN=${MCP_BOOTSTRAP_TOKEN:+<set>}"
