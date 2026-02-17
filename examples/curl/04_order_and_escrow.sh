#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

KEYWORD="${KEYWORD:-watercup}"
PAY_METHOD="${PAY_METHOD:-bsc}"
TOKEN_SYMBOL="${TOKEN_SYMBOL:-USDT}"
BUYER_WALLET="${MCP_BUYER_WALLET:-0x6818384322B0B49adD9568Fc7Fa7A1eb2bD566F2}"
ITEM_RESOURCE="${ITEM_RESOURCE:-taobao}"
DETAIL_LANGUAGE="${DETAIL_LANGUAGE:-ru}"
QUANTITY="${QUANTITY:-1}"

echo "== bootstrap: create_user =="
call_tool "create_user" "{
  \"user_id\": ${MCP_USER_ID},
  \"user_name\": \"mcp_user_${MCP_USER_ID}\"
}" 1 | jq .

echo "== bootstrap: resolve shipping address =="
addresses_resp="$(call_tool "list_addresses" '{}' 2)"
shipping_address_id="$(echo "${addresses_resp}" | jq -r '.result.structuredContent.data[]? | select(.is_default == true) | .id' | head -n1)"
if [[ -z "${shipping_address_id}" || "${shipping_address_id}" == "null" ]]; then
  shipping_address_id="$(echo "${addresses_resp}" | jq -r '.result.structuredContent.data[0].id // empty')"
fi
if [[ -z "${shipping_address_id}" || "${shipping_address_id}" == "null" ]]; then
  create_addr_resp="$(call_tool "create_address" '{
    "country_code":"RU",
    "country_name":"Russia",
    "state":"Moscow",
    "city":"Moscow",
    "street_line1":"Tverskaya 1",
    "recipient_name":"MCP Demo User",
    "recipient_phone":"+79990000000",
    "is_default":true
  }' 3)"
  shipping_address_id="$(echo "${create_addr_resp}" | jq -r '.result.structuredContent.shipping_address_id // .result.structuredContent.data.id')"
fi
echo "[resolved] shipping_address_id=${shipping_address_id}"

echo "== bootstrap: set buyer wallet =="
call_tool "set_buyer_wallet" "{
  \"address\": \"${BUYER_WALLET}\",
  \"chain_id\": 56,
  \"is_primary\": true,
  \"bind_method\": \"injected\"
}" 4 | jq .

echo "== search_products =="
search_resp="$(call_tool "search_products" "{
  \"keyword\": \"${KEYWORD}\",
  \"page_no\": 1,
  \"page_size\": 10
}" 5)"
echo "${search_resp}" | jq .

selected_item="$(echo "${search_resp}" | jq -c '
  (.result.structuredContent.data.data.data // [])
  | map(. + {__best: ((.coupon_price|tonumber?) // (.price|tonumber?) // 999999999)})
  | sort_by(.__best)
  | .[0]
')"
item_id="$(echo "${selected_item}" | jq -r '.item_id // .itemId // empty')"
shop_id="$(echo "${selected_item}" | jq -r '.shop_id // .shopId // empty')"

if [[ -z "${item_id}" ]]; then
  echo "Cannot resolve item_id from search_products." >&2
  exit 1
fi

if [[ -z "${shop_id}" ]]; then
  detail_url="${MCP_BASE_URL}/api/products/detail?item_resource=${ITEM_RESOURCE}&item_id=${item_id}&language=${DETAIL_LANGUAGE}"
  detail_resp="$(curl -sS "${detail_url}" -H "authorization: Bearer ${MCP_TOKEN}")"
  shop_id="$(echo "${detail_resp}" | jq -r '.shop_id // .shopId // .data.shop_id // .data.shopId // .data.data.shop_id // .data.data.shopId // empty')"
fi

if [[ -z "${shop_id}" ]]; then
  echo "Cannot resolve shop_id (search result + detail fallback)." >&2
  exit 1
fi

echo "[selected] item_id=${item_id} shop_id=${shop_id}"

echo "== estimate_shipping =="
estimate_resp="$(call_tool "estimate_shipping" "{
  \"shipping_address_id\": ${shipping_address_id},
  \"shop_id\": \"${shop_id}\",
  \"item_id\": \"${item_id}\",
  \"quantity\": ${QUANTITY}
}" 6)"
echo "${estimate_resp}" | jq .
shipping_quote_id="$(echo "${estimate_resp}" | jq -r '.result.structuredContent.shipping_quote_id // empty')"
if [[ -z "${shipping_quote_id}" ]]; then
  echo "estimate_shipping did not return shipping_quote_id." >&2
  exit 1
fi

echo "== create_order =="
create_order_resp="$(call_tool "create_order" "{
  \"shipping_address_id\": ${shipping_address_id},
  \"shop_id\": \"${shop_id}\",
  \"item_id\": \"${item_id}\",
  \"quantity\": ${QUANTITY},
  \"shipping_quote_id\": \"${shipping_quote_id}\",
  \"pay_method\": \"${PAY_METHOD}\"
}" 7)"
echo "${create_order_resp}" | jq .
order_no="$(echo "${create_order_resp}" | jq -r '.result.structuredContent.order_no // .result.structuredContent.data.data.order_no // empty')"
if [[ -z "${order_no}" ]]; then
  echo "create_order did not return order_no." >&2
  exit 1
fi
echo "[created] order_no=${order_no}"

echo "== create_escrow (tx request only) =="
create_escrow_resp="$(call_tool "create_escrow" "{
  \"order_no\": \"${order_no}\",
  \"token_symbol\": \"${TOKEN_SYMBOL}\",
  \"buyer_wallet\": \"${BUYER_WALLET}\"
}" 8)"
echo "${create_escrow_resp}" | jq .

echo "== fund_escrow (tx request only) =="
fund_resp="$(call_tool "fund_escrow" "{
  \"order_no\": \"${order_no}\",
  \"token_symbol\": \"${TOKEN_SYMBOL}\"
}" 9)"
echo "${fund_resp}" | jq .

echo "== confirm_receipt (tx request only) =="
confirm_resp="$(call_tool "confirm_receipt" "{
  \"order_no\": \"${order_no}\"
}" 10)"
echo "${confirm_resp}" | jq .

echo "== summary =="
jq -n \
  --arg order_no "${order_no}" \
  --arg shipping_quote_id "${shipping_quote_id}" \
  --arg shipping_address_id "${shipping_address_id}" \
  --arg item_id "${item_id}" \
  --arg shop_id "${shop_id}" \
  '{
    order_no: $order_no,
    shipping_quote_id: $shipping_quote_id,
    shipping_address_id: $shipping_address_id,
    item_id: $item_id,
    shop_id: $shop_id,
    note: "Tx request generated. Sign in wallet, then call submit_tx(order_no, action, tx_hash)."
  }'

