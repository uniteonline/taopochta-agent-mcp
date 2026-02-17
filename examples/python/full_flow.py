#!/usr/bin/env python3
"""One-click MCP full flow example (stdlib only).

Flow:
initialize -> tools/list -> create_user -> create_address -> set_buyer_wallet
-> search_products (pick cheapest by coupon_price/price)
-> estimate_shipping -> create_order -> create_escrow -> fund_escrow
-> confirm_receipt -> get_order_proof

Optional tx submission:
- CREATE_TX_HASH
- FUND_TX_HASH
- CONFIRM_TX_HASH
"""

from __future__ import annotations

import json
import os
import sys
import time
import base64
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional


DEFAULT_BUYER_WALLET = ""


def trim_slash(value: str) -> str:
    return str(value or "").rstrip("/")


def derive_api_base_url(raw_base_url: str) -> str:
    base = trim_slash(raw_base_url)
    if base.endswith("/api/mcp"):
        return trim_slash(base[: -len("/api/mcp")])
    if base.endswith("/mcp"):
        return trim_slash(base[: -len("/mcp")])
    return base


def resolve_mcp_endpoint(raw_base_url: str, explicit_endpoint: str) -> str:
    base = trim_slash(raw_base_url)
    endpoint = first_string(explicit_endpoint)
    if endpoint:
        if endpoint.startswith("http://") or endpoint.startswith("https://"):
            return trim_slash(endpoint)
        if base.endswith("/api/mcp") or base.endswith("/mcp"):
            api_base = derive_api_base_url(base)
            if endpoint.startswith("/"):
                return f"{api_base}{endpoint}"
            return f"{api_base}/{endpoint}"
        if endpoint.startswith("/"):
            return f"{base}{endpoint}"
        return f"{base}/{endpoint}"
    if base.endswith("/api/mcp") or base.endswith("/mcp"):
        return base
    return f"{base}/api/mcp"


def first_string(*values: Any) -> str:
    for value in values:
        s = str("" if value is None else value).strip()
        if s:
            return s
    return ""


def to_int(value: Any, fallback: int) -> int:
    try:
        return int(float(value))
    except Exception:
        return fallback


def decode_jwt_sub_unsafe(token: str) -> Optional[int]:
    try:
        parts = str(token or "").split(".")
        if len(parts) < 2:
            return None
        payload_part = parts[1]
        padding = "=" * ((4 - len(payload_part) % 4) % 4)
        payload_json = base64.urlsafe_b64decode((payload_part + padding).encode("utf-8")).decode("utf-8")
        payload = json.loads(payload_json)
        sub = payload.get("sub")
        if sub is None:
            return None
        return int(sub)
    except Exception:
        return None


def parse_tool_result(raw: Dict[str, Any]) -> Any:
    if isinstance(raw, dict) and isinstance(raw.get("structuredContent"), dict):
        return raw["structuredContent"]

    content = raw.get("content") if isinstance(raw, dict) else None
    text = None
    if isinstance(content, list):
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text" and isinstance(item.get("text"), str):
                text = item["text"]
                break
    if not text:
        return raw
    try:
        return json.loads(text)
    except Exception:
        return {"success": not bool(raw.get("isError")), "message": text}


def ensure_tool_success(step: str, payload: Any) -> None:
    if isinstance(payload, dict) and payload.get("success") is False:
        raise RuntimeError(f"{step} failed: {payload.get('error') or payload.get('message') or 'unknown error'}")


def collect_arrays(node: Any, out: List[list], depth: int = 0) -> None:
    if depth > 6 or node is None:
        return
    if isinstance(node, list):
        out.append(node)
        for item in node:
            collect_arrays(item, out, depth + 1)
        return
    if isinstance(node, dict):
        for value in node.values():
            collect_arrays(value, out, depth + 1)


def to_price_number(raw: Any) -> Optional[float]:
    if raw is None:
        return None
    s = str(raw).strip().replace(",", "")
    if not s:
        return None
    try:
        n = float(s)
        if n >= 0:
            return n
    except Exception:
        return None
    return None


def get_comparable_price(product: Dict[str, Any]) -> Optional[float]:
    coupon = to_price_number(product.get("coupon_price", product.get("couponPrice")))
    price = to_price_number(product.get("price"))
    if coupon is not None and price is not None:
        return min(coupon, price)
    if coupon is not None:
        return coupon
    if price is not None:
        return price
    return None


def looks_like_product(item: Any) -> bool:
    if not isinstance(item, dict):
        return False
    item_id = first_string(item.get("item_id"), item.get("itemId"), item.get("id"))
    if not item_id:
        return False
    hints = [
        item.get("title"),
        item.get("shop_name"),
        item.get("price"),
        item.get("main_image_url"),
        item.get("coupon_price"),
        item.get("inventory"),
    ]
    has_product_hint = any(v is not None for v in hints)
    return has_product_hint or bool(first_string(item.get("shop_id"), item.get("shopId"), item.get("seller_id"), item.get("sellerId")))


def get_sku_id(product: Dict[str, Any]) -> str:
    return first_string(
        product.get("sku_id"),
        product.get("skuId"),
        product.get("default_sku_id"),
        product.get("defaultSkuId"),
        product.get("sku"),
    )


def pick_cheapest_product(payload: Any) -> Optional[Dict[str, Any]]:
    arrays: List[list] = []
    collect_arrays(payload, arrays)
    products: List[Dict[str, Any]] = []
    for arr in arrays:
        for item in arr:
            if looks_like_product(item):
                products.append(item)

    best = None
    best_price = float("inf")
    for product in products:
        p = get_comparable_price(product)
        if p is None:
            continue
        if p < best_price:
            best_price = p
            best = product
    if best is not None:
        return best
    return products[0] if products else None


def extract_addresses(payload: Any) -> List[Dict[str, Any]]:
    arrays: List[list] = []
    collect_arrays(payload, arrays)
    for arr in arrays:
        matches = [it for it in arr if isinstance(it, dict) and str(it.get("id", "")).strip()]
        if matches:
            return matches
    return []


def get_order_no(payload: Dict[str, Any]) -> str:
    data = payload.get("data") if isinstance(payload, dict) else {}
    nested_data = data.get("data") if isinstance(data, dict) else {}
    return first_string(
        payload.get("order_no"),
        data.get("order_no") if isinstance(data, dict) else None,
        nested_data.get("order_no") if isinstance(nested_data, dict) else None,
    )


def get_shipping_quote_id(payload: Dict[str, Any]) -> str:
    data = payload.get("data") if isinstance(payload, dict) else {}
    return first_string(payload.get("shipping_quote_id"), data.get("shipping_quote_id") if isinstance(data, dict) else None)


def get_tx_request(payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if not isinstance(payload, dict):
        return None
    if isinstance(payload.get("tx_request"), dict):
        return payload["tx_request"]
    data = payload.get("data")
    if isinstance(data, dict) and isinstance(data.get("tx_request"), dict):
        return data["tx_request"]
    return None


def _http_json(url: str, method: str, body: Optional[Dict[str, Any]], token: str) -> Dict[str, Any]:
    payload_bytes = None
    headers = {"content-type": "application/json", "authorization": f"Bearer {token}"}
    if body is not None:
        payload_bytes = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=payload_bytes, method=method.upper(), headers=headers)
    with urllib.request.urlopen(req, timeout=60) as resp:
        text = resp.read().decode("utf-8")
        return json.loads(text) if text else {}


def issue_mcp_token(
    token_url: str,
    client_id: str,
    client_secret: str,
    user_id: int,
    access_ttl_sec: int,
    refresh_ttl_sec: int,
) -> Dict[str, Any]:
    body: Dict[str, Any] = {
        "grant_type": "client_credentials",
        "client_id": client_id,
        "client_secret": client_secret,
        "sub": int(user_id),
    }
    if access_ttl_sec > 0:
        body["ttl_sec"] = int(access_ttl_sec)
    if refresh_ttl_sec > 0:
        body["refresh_ttl_sec"] = int(refresh_ttl_sec)

    payload_bytes = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        token_url,
        data=payload_bytes,
        method="POST",
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        text = resp.read().decode("utf-8")
        data = json.loads(text) if text else {}
    if not first_string(data.get("access_token")):
        raise RuntimeError(f"Token endpoint returned no access_token: {data}")
    return data


def register_mcp_client(
    register_url: str,
    bootstrap_token: str,
    user_id: int,
    client_id: str,
    display_name: str,
    scope: str,
    access_ttl_sec: int,
    refresh_ttl_sec: int,
) -> Dict[str, Any]:
    body: Dict[str, Any] = {
        "auto_issue_token": True,
        "fixed_sub": int(user_id),
    }
    if client_id:
        body["client_id"] = client_id
    if display_name:
        body["display_name"] = display_name
    if scope:
        body["scope"] = scope
    if access_ttl_sec > 0:
        body["ttl_sec"] = int(access_ttl_sec)
    if refresh_ttl_sec > 0:
        body["refresh_ttl_sec"] = int(refresh_ttl_sec)

    payload_bytes = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        register_url,
        data=payload_bytes,
        method="POST",
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {bootstrap_token}",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        text = resp.read().decode("utf-8")
        data = json.loads(text) if text else {}

    resolved_client_id = first_string(data.get("client_id"), data.get("client", {}).get("client_id"))
    resolved_secret = first_string(data.get("client_secret"))
    if not resolved_client_id or not resolved_secret:
        raise RuntimeError(f"Register endpoint returned invalid client credentials: {data}")
    return data


class McpClient:
    def __init__(self, endpoint: str, token: str) -> None:
        self.endpoint = endpoint
        self.token = token
        self.id = 1

    def rpc(self, method: str, params: Dict[str, Any], with_id: bool = True) -> Dict[str, Any]:
        if with_id:
            body = {"jsonrpc": "2.0", "id": self.id, "method": method, "params": params}
            self.id += 1
        else:
            body = {"jsonrpc": "2.0", "method": method, "params": params}
        result = _http_json(self.endpoint, "POST", body, self.token)
        if not with_id:
            return {}
        if isinstance(result, dict) and isinstance(result.get("error"), dict):
            err = result["error"]
            raise RuntimeError(f"JSON-RPC {err.get('code')}: {err.get('message')}")
        return result.get("result", {})

    def call_tool(self, name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        raw = self.rpc("tools/call", {"name": name, "arguments": arguments}, with_id=True)
        payload = parse_tool_result(raw)
        ensure_tool_success(name, payload)
        if isinstance(payload, dict):
            return payload
        return {"success": True, "data": payload}


def resolve_shop_id_by_detail(base_url: str, token: str, item_id: str, item_resource: str, language: str) -> str:
    query = urllib.parse.urlencode(
        {
            "item_resource": item_resource,
            "item_id": item_id,
            "language": language,
        }
    )
    url = f"{trim_slash(base_url)}/api/products/detail?{query}"
    req = urllib.request.Request(url, method="GET", headers={"authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        text = resp.read().decode("utf-8")
        data = json.loads(text) if text else {}
    return first_string(
        data.get("shop_id"),
        data.get("shopId"),
        data.get("data", {}).get("shop_id") if isinstance(data.get("data"), dict) else None,
        data.get("data", {}).get("shopId") if isinstance(data.get("data"), dict) else None,
        data.get("data", {}).get("data", {}).get("shop_id")
        if isinstance(data.get("data"), dict) and isinstance(data.get("data", {}).get("data"), dict)
        else None,
        data.get("data", {}).get("data", {}).get("shopId")
        if isinstance(data.get("data"), dict) and isinstance(data.get("data", {}).get("data"), dict)
        else None,
    )


def main() -> None:
    base_url_input = trim_slash(os.getenv("MCP_BASE_URL", "https://taopochta.ru/api/mcp"))
    endpoint = resolve_mcp_endpoint(base_url_input, os.getenv("MCP_ENDPOINT", ""))
    api_base_url = derive_api_base_url(base_url_input)
    token_url = first_string(os.getenv("MCP_TOKEN_URL"), f"{api_base_url}/api/mcp/token")
    register_url = first_string(os.getenv("MCP_REGISTER_URL"), f"{api_base_url}/api/mcp/clients/register")

    user_id_env = first_string(os.getenv("MCP_USER_ID"))
    user_id = to_int(user_id_env, int(time.time() * 1000))
    token = first_string(os.getenv("MCP_TOKEN"))
    bootstrap_token = first_string(os.getenv("MCP_BOOTSTRAP_USER_TOKEN"))
    auto_register_client = first_string(os.getenv("MCP_AUTO_REGISTER_CLIENT"), "true").lower() in ("1", "true", "yes", "on")
    client_id = first_string(os.getenv("MCP_CLIENT_ID"))
    client_secret = first_string(os.getenv("MCP_CLIENT_SECRET"))
    register_client_id = first_string(os.getenv("MCP_REGISTER_CLIENT_ID"))
    register_display_name = first_string(os.getenv("MCP_REGISTER_DISPLAY_NAME"), f"mcp_python_{user_id}")
    register_scope = first_string(os.getenv("MCP_REGISTER_SCOPE"))
    access_ttl = to_int(os.getenv("MCP_ACCESS_TOKEN_TTL_SEC", "0"), 0)
    refresh_ttl = to_int(os.getenv("MCP_REFRESH_TOKEN_TTL_SEC", "0"), 0)

    provided_sub = decode_jwt_sub_unsafe(token) if token else None
    bootstrap_sub = decode_jwt_sub_unsafe(bootstrap_token) if bootstrap_token else None
    if provided_sub is not None:
        user_id = provided_sub
    elif not user_id_env and bootstrap_sub is not None:
        user_id = bootstrap_sub

    if not token:
        if not client_id or not client_secret:
            if auto_register_client and bootstrap_token:
                register_resp = register_mcp_client(
                    register_url=register_url,
                    bootstrap_token=bootstrap_token,
                    user_id=user_id,
                    client_id=register_client_id,
                    display_name=register_display_name,
                    scope=register_scope,
                    access_ttl_sec=access_ttl,
                    refresh_ttl_sec=refresh_ttl,
                )
                client_id = first_string(register_resp.get("client_id"), register_resp.get("client", {}).get("client_id"))
                client_secret = first_string(register_resp.get("client_secret"))
                token = first_string(register_resp.get("token_bundle", {}).get("access_token"), register_resp.get("access_token"))
                print(f"[auth] mcp client self-registered: {client_id}")
            else:
                raise RuntimeError(
                    "MCP_TOKEN is not set. Provide MCP_CLIENT_ID/MCP_CLIENT_SECRET or MCP_BOOTSTRAP_USER_TOKEN."
                )
        if not token:
            if not client_id or not client_secret:
                raise RuntimeError("Unable to resolve client credentials after self-register.")
            token_resp = issue_mcp_token(
                token_url=token_url,
                client_id=client_id,
                client_secret=client_secret,
                user_id=user_id,
                access_ttl_sec=access_ttl,
                refresh_ttl_sec=refresh_ttl,
            )
            token = token_resp["access_token"]
            print("[auth] token issued by /api/mcp/token")

    final_sub = decode_jwt_sub_unsafe(token)
    if final_sub is not None:
        user_id = final_sub

    keyword = os.getenv("MCP_KEYWORD", "watercup")
    pay_method = os.getenv("MCP_PAY_METHOD", "bsc")
    token_symbol = os.getenv("MCP_TOKEN_SYMBOL", "USDT").upper()
    buyer_wallet = os.getenv("MCP_BUYER_WALLET", DEFAULT_BUYER_WALLET)
    quantity = to_int(os.getenv("MCP_QUANTITY", "1"), 1)
    item_resource = os.getenv("MCP_ITEM_RESOURCE", "taobao")
    detail_language = os.getenv("MCP_DETAIL_LANGUAGE", "ru")

    create_tx_hash = first_string(os.getenv("CREATE_TX_HASH"))
    fund_tx_hash = first_string(os.getenv("FUND_TX_HASH"))
    confirm_tx_hash = first_string(os.getenv("CONFIRM_TX_HASH"))

    if pay_method.lower() == "bsc" and not buyer_wallet:
        raise RuntimeError("MCP_BUYER_WALLET is required for bsc flow")

    mcp = McpClient(endpoint, token)

    print("== initialize ==")
    init = mcp.rpc(
        "initialize",
        {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": {"name": "python-full-flow", "version": "1.0.0"},
        },
    )
    print(json.dumps(init, ensure_ascii=False, indent=2))
    mcp.rpc("notifications/initialized", {}, with_id=False)

    tools_result = mcp.rpc("tools/list", {})
    tool_names = [t.get("name") for t in tools_result.get("tools", []) if isinstance(t, dict) and t.get("name")]
    print("tools:", tool_names)
    has = lambda name: name in tool_names

    if has("create_user"):
        mcp.call_tool("create_user", {"user_id": user_id, "user_name": f"mcp_user_{user_id}"})

    shipping_address_id = to_int(os.getenv("MCP_SHIPPING_ADDRESS_ID", ""), -1)
    if shipping_address_id < 0 and has("list_addresses"):
        listed = mcp.call_tool("list_addresses", {})
        addresses = extract_addresses(listed.get("data", listed))
        default_addr = next((a for a in addresses if a.get("is_default") is True), None)
        shipping_address_id = to_int((default_addr or {}).get("id", (addresses[0] if addresses else {}).get("id")), -1)

    if shipping_address_id < 0 and has("create_address"):
        addr = mcp.call_tool(
            "create_address",
            {
                "country_code": "RU",
                "country_name": "Russia",
                "state": "Moscow",
                "city": "Moscow",
                "street_line1": "Tverskaya 1",
                "recipient_name": f"MCP User {user_id}",
                "recipient_phone": "+79990000000",
                "is_default": True,
            },
        )
        shipping_address_id = to_int(first_string(addr.get("shipping_address_id"), addr.get("data", {}).get("id")), -1)

    if shipping_address_id < 0:
        raise RuntimeError("Cannot resolve shipping_address_id")
    print("shipping_address_id:", shipping_address_id)

    if pay_method.lower() == "bsc" and has("set_buyer_wallet"):
        mcp.call_tool(
            "set_buyer_wallet",
            {
                "address": buyer_wallet,
                "chain_id": 56,
                "is_primary": True,
                "bind_method": "injected",
            },
        )

    print("== search_products ==")
    search_resp = mcp.call_tool("search_products", {"keyword": keyword, "page_no": 1, "page_size": 10})
    search_payload = search_resp.get("data", search_resp)
    selected = pick_cheapest_product(search_payload)
    if not selected:
        raise RuntimeError("No product found")

    item_id = first_string(selected.get("item_id"), selected.get("itemId"))
    shop_id = first_string(selected.get("shop_id"), selected.get("shopId"), os.getenv("MCP_SHOP_ID"))
    sku_id = first_string(os.getenv("MCP_SKU_ID"), get_sku_id(selected))
    if not item_id:
        raise RuntimeError("No item_id in selected product")
    if not shop_id:
        shop_id = resolve_shop_id_by_detail(api_base_url, token, item_id, item_resource, detail_language)
    if not shop_id:
        raise RuntimeError("Cannot resolve shop_id")
    print(
        json.dumps(
            {
                "item_id": item_id,
                "shop_id": shop_id,
                "sku_id": sku_id or None,
                "coupon_price": selected.get("coupon_price"),
                "price": selected.get("price"),
            },
            ensure_ascii=False,
            indent=2,
        )
    )

    print("== estimate_shipping ==")
    estimate_resp = mcp.call_tool(
        "estimate_shipping",
        {
            "shipping_address_id": shipping_address_id,
            "shop_id": shop_id,
            "item_id": item_id,
            "sku_id": sku_id or None,
            "quantity": quantity,
        },
    )
    shipping_quote_id = get_shipping_quote_id(estimate_resp)
    if not shipping_quote_id:
        raise RuntimeError("estimate_shipping did not return shipping_quote_id")
    print("shipping_quote_id:", shipping_quote_id)
    print(
        "payment_quote:",
        json.dumps(
            estimate_resp.get("payment_quote") or estimate_resp.get("data", {}).get("payment_quote"),
            ensure_ascii=False,
            indent=2,
        ),
    )

    print("== create_order ==")
    create_order_resp = mcp.call_tool(
        "create_order",
        {
            "shipping_address_id": shipping_address_id,
            "shop_id": shop_id,
            "item_id": item_id,
            "sku_id": sku_id or None,
            "quantity": quantity,
            "shipping_quote_id": shipping_quote_id,
            "pay_method": pay_method,
        },
    )
    order_no = get_order_no(create_order_resp)
    if not order_no:
        raise RuntimeError("create_order did not return order_no")
    print("order_no:", order_no)

    print("== create_escrow ==")
    create_escrow_resp = mcp.call_tool(
        "create_escrow",
        {
            "order_no": order_no,
            "token_symbol": token_symbol,
            "buyer_wallet": buyer_wallet,
        },
    )
    print(json.dumps(create_escrow_resp, ensure_ascii=False, indent=2))
    create_tx_request = get_tx_request(create_escrow_resp)
    if create_tx_request:
        print("create_tx_request:", json.dumps(create_tx_request, ensure_ascii=False, indent=2))
    if create_tx_hash:
        submit_create = mcp.call_tool(
            "submit_tx", {"order_no": order_no, "action": "create", "tx_hash": create_tx_hash}
        )
        print("submit_tx(create):", json.dumps(submit_create, ensure_ascii=False, indent=2))

    print("== fund_escrow ==")
    fund_resp = mcp.call_tool("fund_escrow", {"order_no": order_no, "token_symbol": token_symbol})
    print(json.dumps(fund_resp, ensure_ascii=False, indent=2))
    if fund_tx_hash:
        submit_fund = mcp.call_tool("submit_tx", {"order_no": order_no, "action": "fund", "tx_hash": fund_tx_hash})
        print("submit_tx(fund):", json.dumps(submit_fund, ensure_ascii=False, indent=2))

    print("== confirm_receipt ==")
    confirm_resp = mcp.call_tool("confirm_receipt", {"order_no": order_no})
    print(json.dumps(confirm_resp, ensure_ascii=False, indent=2))
    if confirm_tx_hash:
        submit_confirm = mcp.call_tool(
            "submit_tx", {"order_no": order_no, "action": "confirm", "tx_hash": confirm_tx_hash}
        )
        print("submit_tx(confirm):", json.dumps(submit_confirm, ensure_ascii=False, indent=2))

    print("== get_order_proof ==")
    proof = mcp.call_tool("get_order_proof", {"order_no": order_no})
    print(json.dumps(proof, ensure_ascii=False, indent=2))

    print("== summary ==")
    print(
        json.dumps(
            {
                "order_no": order_no,
                "shipping_quote_id": shipping_quote_id,
                "item_id": item_id,
                "shop_id": shop_id,
                "sku_id": sku_id or None,
                "create_submitted": bool(create_tx_hash),
                "fund_submitted": bool(fund_tx_hash),
                "confirm_submitted": bool(confirm_tx_hash),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        print(f"[ERROR] {exc}", file=sys.stderr)
        sys.exit(1)
