# Taopochta Agent MCP

[![GitHub stars](https://img.shields.io/github/stars/uniteonline/taopochta-agent-mcp?style=flat-square)](https://github.com/uniteonline/taopochta-agent-mcp/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/uniteonline/taopochta-agent-mcp?style=flat-square)](https://github.com/uniteonline/taopochta-agent-mcp/network/members)
[![GitHub issues](https://img.shields.io/github/issues/uniteonline/taopochta-agent-mcp?style=flat-square)](https://github.com/uniteonline/taopochta-agent-mcp/issues)
![Protocol](https://img.shields.io/badge/Protocol-MCP%20(JSON--RPC%202.0)-0A66C2?style=flat-square)
![Chain](https://img.shields.io/badge/Chain-BNB%20Smart%20Chain-F3BA2F?style=flat-square)
![Shipping](https://img.shields.io/badge/Shipping-Russia%20Only-orange?style=flat-square)

Production-ready MCP integration kit for AI agents to execute the full Taopochta workflow:
product search -> shipping estimate -> order creation -> escrow create/fund/confirm -> on-chain proof sync.

## Important

**Shipping is currently supported for Russia only.**

## What You Get

- MCP protocol docs: `openapi.yaml`
- End-to-end test script: `scripts/test-mcp-flow.js`
- Runnable examples:
  - `examples/curl/*.sh`
  - `examples/node/full_flow.ts`
  - `examples/python/full_flow.py`

## 15-Minute Quick Start

### 1) Prerequisites

- API service exposes:
  - `POST /api/mcp`
  - `POST /api/mcp/rpc`
- Node.js 18+
- Python 3.9+
- BSC wallet with BNB gas + USDT (for payment flow)

### 2) Environment

```bash
export MCP_BASE_URL="https://taopochta.ru"
export MCP_ENDPOINT="/api/mcp"
export AUTH_TOKEN_SECRET="dev-secret"
export MCP_USER_ID="$(date +%s)"
export MCP_BUYER_WALLET="0xYourBuyerWalletAddress"
```

PowerShell:

```powershell
$env:MCP_BASE_URL="https://taopochta.ru"
$env:MCP_ENDPOINT="/api/mcp"
$env:AUTH_TOKEN_SECRET="dev-secret"
$env:MCP_USER_ID=[int][double]::Parse((Get-Date -UFormat %s))
$env:MCP_BUYER_WALLET="0xYourBuyerWalletAddress"
```

For local development only:

```bash
export MCP_BASE_URL="http://127.0.0.1:3000"
```

If you expose MCP through Nginx as `https://taopochta.ru/mcp`, set:

```bash
export MCP_BASE_URL="https://taopochta.ru"
export MCP_ENDPOINT="/mcp"
```

### 3) Probe MCP

```bash
cd examples/curl
bash 01_initialize.sh
bash 02_tools_list.sh
```

### 4) Run full flow

Interactive JS (recommended for manual wallet signing):

```bash
cd ../../
node scripts/test-mcp-flow.js --keyword watercup
```

TypeScript:

```bash
cd examples/node
npx tsx full_flow.ts
```

Python:

```bash
cd examples/python
python full_flow.py
```

## Architecture

```mermaid
flowchart LR
  A[Agent / Client] --> B[MCP Endpoint /api/mcp]
  B --> C[Tool Router]
  C --> D[search_products]
  C --> E[estimate_shipping]
  C --> F[create_order]
  C --> G[create_escrow]
  C --> H[fund_escrow]
  C --> I[confirm_receipt]
  D --> J[Taopochta Product APIs]
  E --> K[/api/items/shipping/estimate]
  F --> L[Order Service]
  G --> M[Escrow Contract on BSC]
  H --> M
  I --> M
  M --> N[submit_tx + get_order_proof]
  N --> A
```

## Available MCP Tools

1. `create_user`
2. `list_addresses`
3. `create_address`
4. `set_buyer_wallet`
5. `list_wallets`
6. `search_products`
7. `estimate_shipping`
8. `create_order`
9. `create_escrow`
10. `fund_escrow`
11. `confirm_receipt`
12. `open_dispute`
13. `vote_dispute`
14. `execute_dispute`
15. `resolve_timeout`
16. `submit_tx`
17. `get_order_proof`

## Canonical Payment Flow

1. `search_products`
2. `estimate_shipping`
3. `create_order` (must include `shipping_quote_id`, and `sku_id` when present)
4. `create_escrow`
5. Sign create tx in wallet
6. `submit_tx(action=create, tx_hash=...)`
7. `fund_escrow`
8. Sign fund tx in wallet
9. `submit_tx(action=fund, tx_hash=...)`
10. `confirm_receipt`
11. Sign confirm tx in wallet
12. `submit_tx(action=confirm, tx_hash=...)`
13. `get_order_proof`

Security rule: payment amount must come from server-side order quote (`create_order`), not client-side math.

## Environment Variables

| Name | Required | Example | Purpose |
|---|---|---|---|
| `MCP_BASE_URL` | Yes | `https://taopochta.ru` | API base URL |
| `MCP_ENDPOINT` | No | `/api/mcp` | MCP endpoint path |
| `AUTH_TOKEN_SECRET` | Local yes | `dev-secret` | JWT signing secret |
| `MCP_TOKEN` | Optional | `eyJ...` | If unset, examples generate token |
| `MCP_USER_ID` | Optional | `1771301696853` | JWT `sub` |
| `MCP_BUYER_WALLET` | BSC flow yes | `0x...` | Buyer wallet |
| `MCP_SKU_ID` | Optional | `5913730265710` | Override SKU if needed |
| `CREATE_TX_HASH` | Optional | `0x...` | Auto submit create tx |
| `FUND_TX_HASH` | Optional | `0x...` | Auto submit fund tx |
| `CONFIRM_TX_HASH` | Optional | `0x...` | Auto submit confirm tx |

## Repo Structure

```text
taopochta-agent-mcp/
  README.md
  openapi.yaml
  scripts/
    test-mcp-flow.js
  examples/
    curl/
      _common.sh
      01_initialize.sh
      02_tools_list.sh
      03_call_create_user.sh
      04_order_and_escrow.sh
    node/
      full_flow.ts
    python/
      full_flow.py
```

## Troubleshooting

- `estimate_shipping` has no `shipping_quote_id`
  - Check address/shop/item (and `sku_id` for variant products).
- `Transaction Hash not found`
  - Usually canceled in wallet or never broadcast.
- Escrow amount mismatch
  - Trust server quote from `create_order` only.

## Publish

```bash
git add .
git commit -m "docs: improve README and examples"
git push
```

---

## Описание на русском

`taopochta-agent-mcp` — это готовый набор для интеграции MCP, чтобы агент мог пройти полный сценарий:
поиск товара, расчет доставки, создание заказа, создание/пополнение escrow, подтверждение получения и синхронизация on-chain proof.

### Важно

**Сейчас поддерживается доставка только в Россию.**

### Быстрый старт (15 минут)

1. Запустите API с эндпоинтами `POST /api/mcp` и `POST /api/mcp/rpc`.
2. Установите переменные окружения (`MCP_BASE_URL`, `MCP_ENDPOINT`, `AUTH_TOKEN_SECRET`, `MCP_BUYER_WALLET`).
3. Проверьте MCP:
   - `bash examples/curl/01_initialize.sh`
   - `bash examples/curl/02_tools_list.sh`
4. Запустите полный сценарий:
   - `node scripts/test-mcp-flow.js --keyword watercup`
   - или `npx tsx examples/node/full_flow.ts`
   - или `python examples/python/full_flow.py`

### Рекомендуемый порядок инструментов

`search_products` -> `estimate_shipping` -> `create_order` -> `create_escrow` -> `fund_escrow` -> `confirm_receipt` -> `submit_tx` -> `get_order_proof`

Если у товара есть варианты, обязательно передавайте `sku_id` в `estimate_shipping` и `create_order`.
Сумма оплаты должна браться только из серверной котировки (`create_order`), а не рассчитываться на клиенте.
