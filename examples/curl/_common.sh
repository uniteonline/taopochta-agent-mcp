#!/usr/bin/env bash
set -euo pipefail

MCP_BASE_URL="${MCP_BASE_URL:-https://taopochta.ru/api/mcp}"
MCP_ENDPOINT="${MCP_ENDPOINT:-}"
MCP_USER_ID="${MCP_USER_ID:-$(date +%s)}"
MCP_CLIENT_ID="${MCP_CLIENT_ID:-}"
MCP_CLIENT_SECRET="${MCP_CLIENT_SECRET:-}"
MCP_BOOTSTRAP_USER_TOKEN="${MCP_BOOTSTRAP_USER_TOKEN:-}"
MCP_AUTO_REGISTER_CLIENT="${MCP_AUTO_REGISTER_CLIENT:-true}"
MCP_REGISTER_CLIENT_ID="${MCP_REGISTER_CLIENT_ID:-}"
MCP_REGISTER_DISPLAY_NAME="${MCP_REGISTER_DISPLAY_NAME:-}"
MCP_REGISTER_SCOPE="${MCP_REGISTER_SCOPE:-}"
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
MCP_REGISTER_URL="${MCP_REGISTER_URL:-${MCP_API_BASE_URL%/}/api/mcp/clients/register}"

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
  if [[ -z "${MCP_CLIENT_ID}" || -z "${MCP_CLIENT_SECRET}" ]]; then
    auto_register_flag="$(echo "${MCP_AUTO_REGISTER_CLIENT}" | tr '[:upper:]' '[:lower:]')"
    if [[ "${auto_register_flag}" =~ ^(1|true|yes|on)$ ]] && [[ -n "${MCP_BOOTSTRAP_USER_TOKEN}" ]]; then
      register_body="$(jq -nc \
        --arg client_id "${MCP_REGISTER_CLIENT_ID}" \
        --arg display_name "${MCP_REGISTER_DISPLAY_NAME}" \
        --arg scope "${MCP_REGISTER_SCOPE}" \
        --arg ttl "${MCP_ACCESS_TOKEN_TTL_SEC}" \
        --arg refresh_ttl "${MCP_REFRESH_TOKEN_TTL_SEC}" \
        '{
          auto_issue_token: true
        }
        + (if ($client_id | length) > 0 then { client_id: $client_id } else {} end)
        + (if ($display_name | length) > 0 then { display_name: $display_name } else {} end)
        + (if ($scope | length) > 0 then { scope: $scope } else {} end)
        + (if ($ttl | length) > 0 then { ttl_sec: ($ttl | tonumber) } else {} end)
        + (if ($refresh_ttl | length) > 0 then { refresh_ttl_sec: ($refresh_ttl | tonumber) } else {} end)')"

      register_resp="$(curl -sS "${MCP_REGISTER_URL}" \
        -H "content-type: application/json" \
        -H "authorization: Bearer ${MCP_BOOTSTRAP_USER_TOKEN}" \
        -d "${register_body}")"

      MCP_CLIENT_ID="$(echo "${register_resp}" | jq -r '.client_id // .client.client_id // empty')"
      MCP_CLIENT_SECRET="$(echo "${register_resp}" | jq -r '.client_secret // empty')"
      MCP_TOKEN="$(echo "${register_resp}" | jq -r '.token_bundle.access_token // .access_token // empty')"
      if [[ -z "${MCP_CLIENT_ID}" || -z "${MCP_CLIENT_SECRET}" ]]; then
        echo "Failed to self-register MCP client from ${MCP_REGISTER_URL}" >&2
        echo "Response: ${register_resp}" >&2
        exit 1
      fi
      echo "[auth] self-registered MCP client_id=${MCP_CLIENT_ID}"
    else
      echo "MCP_TOKEN is not set. Please set MCP_CLIENT_ID/MCP_CLIENT_SECRET or MCP_BOOTSTRAP_USER_TOKEN." >&2
      exit 1
    fi
  fi

  if [[ -z "${MCP_TOKEN}" ]]; then
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
fi

decoded_sub="$(decode_jwt_sub "${MCP_TOKEN}")"
if [[ -n "${decoded_sub}" && "${decoded_sub}" =~ ^[0-9]+$ ]]; then
  MCP_USER_ID="${decoded_sub}"
fi

export MCP_BASE_URL MCP_API_BASE_URL MCP_ENDPOINT MCP_RPC_URL MCP_TOKEN_URL MCP_USER_ID
export MCP_CLIENT_ID MCP_CLIENT_SECRET MCP_ACCESS_TOKEN_TTL_SEC MCP_REFRESH_TOKEN_TTL_SEC
export MCP_BOOTSTRAP_USER_TOKEN MCP_AUTO_REGISTER_CLIENT MCP_REGISTER_URL
export MCP_REGISTER_CLIENT_ID MCP_REGISTER_DISPLAY_NAME MCP_REGISTER_SCOPE
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
echo "[env] MCP_REGISTER_URL=${MCP_REGISTER_URL}"
echo "[env] MCP_USER_ID=${MCP_USER_ID}"
echo "[env] MCP_CLIENT_ID=${MCP_CLIENT_ID:-<not-set>}"
echo "[env] MCP_BOOTSTRAP_USER_TOKEN=${MCP_BOOTSTRAP_USER_TOKEN:+<set>}"
