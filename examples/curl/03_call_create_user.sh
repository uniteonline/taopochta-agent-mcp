#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

echo "== tools/call create_user =="
call_tool "create_user" "{
  \"user_id\": ${MCP_USER_ID},
  \"user_name\": \"mcp_user_${MCP_USER_ID}\"
}" 1 | jq .

