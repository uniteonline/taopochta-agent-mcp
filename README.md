# Taopochta Agent MCP

[![GitHub stars](https://img.shields.io/github/stars/uniteonline/taopochta-agent-mcp?style=flat-square)](https://github.com/uniteonline/taopochta-agent-mcp/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/uniteonline/taopochta-agent-mcp?style=flat-square)](https://github.com/uniteonline/taopochta-agent-mcp/network/members)
[![GitHub issues](https://img.shields.io/github/issues/uniteonline/taopochta-agent-mcp?style=flat-square)](https://github.com/uniteonline/taopochta-agent-mcp/issues)
![MCP](https://img.shields.io/badge/Protocol-MCP%20(JSON--RPC%202.0)-0A66C2?style=flat-square)
![Chain](https://img.shields.io/badge/Chain-BNB%20Smart%20Chain-F3BA2F?style=flat-square)
![Shipping](https://img.shields.io/badge/Shipping-Russia%20Only-orange?style=flat-square)

EN: A practical MCP integration kit for agents to run Taopochta cross-border order + escrow flows end-to-end.  
中文：一个可直接落地的 MCP 集成套件，帮助 Agent 端到端打通 Taopochta 下单与托管支付流程。

## Important / 重要说明

EN: **At this stage, shipping is supported for Russia only.**  
中文：**目前只支持俄罗斯收货地址。**

## What This Repo Gives You / 你能拿到什么

EN:
- MCP protocol docs (`openapi.yaml`)
- Copy-paste runnable examples (curl / Node / Python)
- End-to-end test script for create -> fund -> confirm flow

中文：
- MCP 协议文档（`openapi.yaml`）
- 可直接运行的示例（curl / Node / Python）
- 覆盖 create -> fund -> confirm 的全流程测试脚本

## 15-Minute Quick Start / 15 分钟快速上手

### Step 0: Prerequisites / 前置条件

EN:
- API service is running and exposes:
  - `POST /api/mcp`
  - `POST /api/mcp/rpc`
- Node.js 18+ (for JS examples)
- Python 3.9+ (for Python example)
- If testing on BSC mainnet: wallet with BNB gas + USDT balance

中文：
- 已启动 API 服务，并提供：
  - `POST /api/mcp`
  - `POST /api/mcp/rpc`
- Node.js 18+（运行 JS 示例）
- Python 3.9+（运行 Python 示例）
- 若测试 BSC 主网：钱包需有 BNB Gas 与 USDT 余额

### Step 1: Set env / 配置环境变量

```bash
export MCP_BASE_URL="http://127.0.0.1:3000"
export MCP_ENDPOINT="/api/mcp"
export AUTH_TOKEN_SECRET="dev-secret"
export MCP_USER_ID="$(date +%s)"
export MCP_BUYER_WALLET="0x6818384322B0B49adD9568Fc7Fa7A1eb2bD566F2"
```

Windows PowerShell:

```powershell
$env:MCP_BASE_URL="http://127.0.0.1:3000"
$env:MCP_ENDPOINT="/api/mcp"
$env:AUTH_TOKEN_SECRET="dev-secret"
$env:MCP_USER_ID=[int][double]::Parse((Get-Date -UFormat %s))
$env:MCP_BUYER_WALLET="0x6818384322B0B49adD9568Fc7Fa7A1eb2bD566F2"
```

### Step 2: Verify MCP alive / 验证 MCP 可用

```bash
cd examples/curl
bash 01_initialize.sh
bash 02_tools_list.sh
```

### Step 3: Run a full flow / 跑一条完整链路

Option A (JS test script, interactive with tx hash input):

```bash
cd ../../
node scripts/test-mcp-flow.js --keyword watercup
```

Option B (TypeScript one-click):

```bash
cd examples/node
npx tsx full_flow.ts
```

Option C (Python one-click):

```bash
cd examples/python
python full_flow.py
```

EN: In normal production integration, your agent signs tx via wallet and then calls `submit_tx`.  
中文：生产场景中，Agent 需要通过钱包签名交易，然后调用 `submit_tx` 回填链上交易哈希。

## Architecture / 架构图

```mermaid
flowchart LR
  A[Agent / Client] --> B[MCP Endpoint\n/api/mcp]
  B --> C[Tool Router]
  C --> D[search_products]
  C --> E[estimate_shipping]
  C --> F[create_order]
  C --> G[create_escrow]
  C --> H[fund_escrow]
  C --> I[confirm_receipt]
  D --> J[Taopochta Product APIs]
  E --> K[/api/items/shipping/estimate]
  F --> L[Order Service\nserver-side amount source]
  G --> M[Escrow Contract\nBNB Smart Chain]
  H --> M
  I --> M
  M --> N[submit_tx + get_order_proof]
  N --> A
```

## MCP Tools / 工具列表

| Tool | EN | 中文 |
|---|---|---|
| `create_user` | Create user profile | 创建用户 |
| `list_addresses` | List shipping addresses | 查询地址列表 |
| `create_address` | Create shipping address | 创建收货地址 |
| `set_buyer_wallet` | Bind buyer wallet | 绑定买家钱包 |
| `list_wallets` | List wallets by chain | 查询钱包列表 |
| `search_products` | Search products | 搜索商品 |
| `estimate_shipping` | Estimate domestic + international shipping | 计算国内/国际运费 |
| `create_order` | Create order with shipping quote | 基于运费报价创建订单 |
| `create_escrow` | Build escrow create tx request | 生成托管创建交易参数 |
| `fund_escrow` | Build escrow funding tx request | 生成托管注资交易参数 |
| `confirm_receipt` | Build receipt confirm tx request | 生成确认收货交易参数 |
| `open_dispute` | Open dispute | 发起争议 |
| `vote_dispute` | Vote on dispute | 争议投票 |
| `execute_dispute` | Execute dispute result | 执行争议结果 |
| `resolve_timeout` | Resolve timeout case | 处理超时单 |
| `submit_tx` | Submit on-chain tx hash to backend | 回填链上交易哈希 |
| `get_order_proof` | Query escrow/order proof | 查询订单链上证明 |

## Canonical Payment Flow / 标准支付流程

1. `search_products`
2. `estimate_shipping` (must run before `create_order`)
3. `create_order` (server stores quote + total)
4. `create_escrow`
5. Wallet sends create tx
6. `submit_tx(action=create, tx_hash=...)`
7. `fund_escrow`
8. Wallet sends fund tx
9. `submit_tx(action=fund, tx_hash=...)`
10. `confirm_receipt`
11. Wallet sends confirm tx
12. `submit_tx(action=confirm, tx_hash=...)`
13. `get_order_proof`

EN: Payment amount must come from server-side order quote, not client-side calculation.  
中文：支付金额必须以服务端订单报价为准，不能由客户端自行计算。

## Repository Structure / 目录结构

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

## Key Environment Variables / 关键环境变量

| Name | Required | Example | Description |
|---|---|---|---|
| `MCP_BASE_URL` | Yes | `http://127.0.0.1:3000` | API base URL |
| `MCP_ENDPOINT` | No | `/api/mcp` | MCP endpoint path |
| `AUTH_TOKEN_SECRET` | Local yes | `dev-secret` | HS256 JWT signing secret |
| `MCP_TOKEN` | Optional | `eyJ...` | If not set, examples generate token |
| `MCP_USER_ID` | Optional | `1771301696853` | User id in token `sub` |
| `MCP_BUYER_WALLET` | BSC flow yes | `0x...` | Buyer wallet address |
| `CREATE_TX_HASH` | Optional | `0x...` | Auto submit create tx proof |
| `FUND_TX_HASH` | Optional | `0x...` | Auto submit fund tx proof |
| `CONFIRM_TX_HASH` | Optional | `0x...` | Auto submit confirm tx proof |

## Troubleshooting / 常见问题

1. `estimate_shipping` missing `shipping_quote_id`
   - EN: Ensure address/shop/item are valid and quote not expired.
   - 中文：检查地址、店铺、商品参数是否正确，以及报价是否过期。
2. `Transaction Hash not found`
   - EN: Often means tx was cancelled by wallet or never broadcasted.
   - 中文：通常是钱包取消了交易，或交易并未真正广播上链。
3. Escrow amount mismatch
   - EN: Always derive from `create_order` server quote (`total_amount_usdt`).
   - 中文：始终以 `create_order` 返回的服务端报价（`total_amount_usdt`）为准。

## Publish to GitHub / 发布到 GitHub

```bash
git init
git add .
git commit -m "docs: add bilingual MCP integration kit"
git branch -M main
git remote add origin https://github.com/uniteonline/taopochta-agent-mcp.git
git push -u origin main
```

