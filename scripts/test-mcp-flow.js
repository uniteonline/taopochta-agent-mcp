#!/usr/bin/env node
/* eslint-disable no-console */
const readline = require('readline');

const DEFAULT_BUYER_WALLET = '';

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) continue;
    const key = raw.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      result[key] = 'true';
      continue;
    }
    result[key] = next;
    i += 1;
  }
  return result;
}

function isTruthy(raw) {
  const value = String(raw || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(value);
}

function trimSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

function toInt(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function firstString(...values) {
  for (const v of values) {
    const s = v == null ? '' : String(v).trim();
    if (s) return s;
  }
  return '';
}

function deriveApiBaseUrl(rawBaseUrl) {
  const base = trimSlash(rawBaseUrl);
  if (base.endsWith('/api/mcp')) return trimSlash(base.slice(0, -'/api/mcp'.length));
  if (base.endsWith('/mcp')) return trimSlash(base.slice(0, -'/mcp'.length));
  return base;
}

function resolveMcpEndpoint(rawBaseUrl, explicitEndpoint) {
  const base = trimSlash(rawBaseUrl);
  const endpoint = firstString(explicitEndpoint);
  if (endpoint) {
    if (/^https?:\/\//i.test(endpoint)) return trimSlash(endpoint);
    if (base.endsWith('/api/mcp') || base.endsWith('/mcp')) {
      const apiBase = deriveApiBaseUrl(base);
      return endpoint.startsWith('/') ? `${apiBase}${endpoint}` : `${apiBase}/${endpoint}`;
    }
    return endpoint.startsWith('/') ? `${base}${endpoint}` : `${base}/${endpoint}`;
  }
  if (base.endsWith('/api/mcp') || base.endsWith('/mcp')) return base;
  return `${base}/api/mcp`;
}

function generateTestUserId() {
  const nowSec = Math.floor(Date.now() / 1000);
  const rand = Math.floor(Math.random() * 1000);
  return nowSec * 1000 + rand;
}

function decodeJwtSubUnsafe(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return NaN;
    const payloadRaw = Buffer.from(parts[1], 'base64url').toString('utf8');
    const payload = JSON.parse(payloadRaw);
    return toPositiveIntOrNaN(payload?.sub);
  } catch {
    return NaN;
  }
}

function isTxHash(value) {
  return /^0x[a-fA-F0-9]{64}$/.test(String(value || '').trim());
}

async function promptText(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(String(answer || '').trim());
    });
  });
}

async function askTxHash(stepLabel, interactive) {
  if (!interactive) return '';
  if (!process.stdin.isTTY) {
    console.log(`[${stepLabel}] interactive mode requires TTY; skip asking tx hash.`);
    return '';
  }
  while (true) {
    const answer = await promptText(
      `[${stepLabel}] Paste tx hash (0x...64) then Enter, or type "skip": `,
    );
    if (!answer || answer.toLowerCase() === 'skip') return '';
    if (isTxHash(answer)) return answer;
    console.log(`[${stepLabel}] Invalid tx hash format, please retry.`);
  }
}

function ensureToolSuccess(stepName, payload) {
  if (payload && payload.success === false) {
    const message = firstString(payload.error, payload.message, `${stepName} failed`);
    throw new Error(message);
  }
}

async function postJson(url, body, headers, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await resp.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!resp.ok) {
      const details = json ? JSON.stringify(json) : text;
      throw new Error(`HTTP ${resp.status} ${resp.statusText}: ${details}`);
    }
    return json || {};
  } finally {
    clearTimeout(timer);
  }
}

async function issueMcpToken(params) {
  const body = {
    grant_type: 'client_credentials',
    client_id: params.clientId,
    client_secret: params.clientSecret,
    sub: params.userId,
  };
  if (params.ttlSec > 0) body.ttl_sec = params.ttlSec;
  if (params.refreshTtlSec > 0) body.refresh_ttl_sec = params.refreshTtlSec;

  const tokenResp = await postJson(params.tokenUrl, body, {}, params.timeoutMs);
  const accessToken = firstString(tokenResp?.access_token);
  if (!accessToken) {
    throw new Error(`Token endpoint did not return access_token: ${JSON.stringify(tokenResp)}`);
  }
  return tokenResp;
}

async function registerMcpClient(params) {
  const body = {};
  if (params.clientId) body.client_id = params.clientId;
  if (params.displayName) body.display_name = params.displayName;
  if (params.scope) body.scope = params.scope;
  if (params.userId > 0) body.fixed_sub = params.userId;
  body.auto_issue_token = true;
  if (params.ttlSec > 0) body.ttl_sec = params.ttlSec;
  if (params.refreshTtlSec > 0) body.refresh_ttl_sec = params.refreshTtlSec;

  const registerResp = await postJson(
    params.registerUrl,
    body,
    {
      authorization: `Bearer ${params.bootstrapToken}`,
    },
    params.timeoutMs,
  );

  const clientId = firstString(registerResp?.client_id, registerResp?.client?.client_id);
  const clientSecret = firstString(registerResp?.client_secret);
  const tokenBundle = registerResp?.token_bundle || {};
  const accessToken = firstString(tokenBundle?.access_token, registerResp?.access_token);
  if (!clientId || !clientSecret) {
    throw new Error(`Client register endpoint did not return client credentials: ${JSON.stringify(registerResp)}`);
  }
  return {
    clientId,
    clientSecret,
    accessToken,
    raw: registerResp,
  };
}

async function getJson(url, headers, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        ...headers,
      },
      signal: controller.signal,
    });
    const text = await resp.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!resp.ok) {
      const details = json ? JSON.stringify(json) : text;
      throw new Error(`HTTP ${resp.status} ${resp.statusText}: ${details}`);
    }
    return json || {};
  } finally {
    clearTimeout(timer);
  }
}

function collectArrays(node, out, depth = 0) {
  if (depth > 5 || node == null) return;
  if (Array.isArray(node)) {
    out.push(node);
    for (const item of node) collectArrays(item, out, depth + 1);
    return;
  }
  if (typeof node === 'object') {
    for (const key of Object.keys(node)) {
      collectArrays(node[key], out, depth + 1);
    }
  }
}

function looksLikeProduct(item) {
  if (!item || typeof item !== 'object') return false;
  const itemId = firstString(item.item_id, item.itemId, item.id);
  if (!itemId) return false;
  const hasProductHint = [
    item.title,
    item.shop_name,
    item.price,
    item.main_image_url,
    item.coupon_price,
    item.inventory,
  ].some((v) => v !== undefined && v !== null);
  return hasProductHint || Boolean(firstString(item.shop_id, item.shopId, item.seller_id, item.sellerId));
}

function toPriceNumber(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? raw : null;
  const cleaned = String(raw).trim().replace(/,/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function getComparableProductPrice(product) {
  const couponPrice = toPriceNumber(product?.coupon_price ?? product?.couponPrice);
  const price = toPriceNumber(product?.price);
  if (couponPrice != null && price != null) return Math.min(couponPrice, price);
  if (couponPrice != null) return couponPrice;
  if (price != null) return price;
  return null;
}

function collectProducts(payload) {
  const arrays = [];
  collectArrays(payload, arrays);
  const products = [];
  for (const arr of arrays) {
    if (!Array.isArray(arr) || !arr.length) continue;
    for (const item of arr) {
      if (looksLikeProduct(item)) products.push(item);
    }
  }
  return products;
}

function pickFirstProduct(payload) {
  const products = collectProducts(payload);
  return products.length ? products[0] : null;
}

function pickCheapestProduct(payload) {
  const products = collectProducts(payload);
  if (!products.length) return null;

  let best = null;
  let bestPrice = Infinity;
  for (const product of products) {
    const comparablePrice = getComparableProductPrice(product);
    if (comparablePrice == null) continue;
    if (comparablePrice < bestPrice) {
      bestPrice = comparablePrice;
      best = product;
    }
  }
  return best || products[0];
}

function productToOrderFields(product) {
  if (!product || typeof product !== 'object') return null;
  const itemId = firstString(product.item_id, product.itemId, product.id);
  const shopId = firstString(product.shop_id, product.shopId, product.seller_id, product.sellerId);
  const skuId = firstString(
    product.sku_id,
    product.skuId,
    product.default_sku_id,
    product.defaultSkuId,
    product.sku,
  );
  const title = firstString(product.title, product.item_title, product.name);
  if (!itemId) return null;
  return {
    itemId,
    shopId: shopId || null,
    skuId: skuId || null,
    title: title || '(no title)',
  };
}

function looksLikeAddress(item) {
  if (!item || typeof item !== 'object') return false;
  const id = Number(item.id);
  if (Number.isFinite(id) && id > 0) return true;
  return Boolean(
    firstString(
      item.street_line1,
      item.streetLine1,
      item.recipient_name,
      item.recipientName,
      item.city,
      item.state,
    ),
  );
}

function extractAddresses(payload) {
  if (!payload) return [];
  const arrays = [];
  collectArrays(payload, arrays);
  for (const arr of arrays) {
    if (!Array.isArray(arr) || !arr.length) continue;
    const matched = arr.filter((it) => looksLikeAddress(it));
    if (matched.length > 0) return matched;
  }
  return [];
}

function toPositiveIntOrNaN(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return NaN;
  return Math.floor(n);
}

function pickAddressId(addresses, preferredIdRaw) {
  const preferredId = toPositiveIntOrNaN(preferredIdRaw);
  const normalized = Array.isArray(addresses)
    ? addresses
        .map((a) => ({
          ...a,
          __id: toPositiveIntOrNaN(a?.id),
        }))
        .filter((a) => Number.isFinite(a.__id))
    : [];
  if (!normalized.length) return NaN;
  if (Number.isFinite(preferredId)) {
    const matched = normalized.find((a) => a.__id === preferredId);
    if (matched) return matched.__id;
  }
  const defaultAddress =
    normalized.find((a) => a?.is_default === true || String(a?.is_default).toLowerCase() === 'true') ||
    normalized[0];
  return defaultAddress?.__id || NaN;
}

function looksLikeWallet(item) {
  if (!item || typeof item !== 'object') return false;
  const addr = firstString(item.address, item.wallet, item.buyer_wallet);
  return /^0x[a-fA-F0-9]{40}$/.test(addr);
}

function extractWallets(payload) {
  if (!payload) return [];
  const arrays = [];
  collectArrays(payload, arrays);
  for (const arr of arrays) {
    if (!Array.isArray(arr) || !arr.length) continue;
    const matched = arr.filter((it) => looksLikeWallet(it));
    if (matched.length > 0) return matched;
  }
  return [];
}

function findPrimaryWallet(wallets, chainId) {
  const expectedChain = Number(chainId);
  const list = Array.isArray(wallets) ? wallets : [];
  const sameChain = list.filter((w) => !Number.isFinite(expectedChain) || Number(w?.chain_id) === expectedChain);
  const primary =
    sameChain.find((w) => w?.is_primary === true || String(w?.is_primary).toLowerCase() === 'true') ||
    sameChain[0] ||
    list[0] ||
    null;
  return primary;
}

function pickShopIdFromDetailPayload(payload) {
  return firstString(
    payload?.shop_id,
    payload?.shopId,
    payload?.seller_id,
    payload?.sellerId,
    payload?.data?.shop_id,
    payload?.data?.shopId,
    payload?.data?.seller_id,
    payload?.data?.sellerId,
    payload?.data?.data?.shop_id,
    payload?.data?.data?.shopId,
    payload?.data?.data?.seller_id,
    payload?.data?.data?.sellerId,
  );
}

async function resolveShopIdByDetail(params) {
  if (!params?.itemId) return { shopId: '', raw: null };
  const query = new URLSearchParams({
    item_resource: params.itemResource || 'taobao',
    item_id: String(params.itemId),
    language: params.language || 'ru',
  });
  const url = `${trimSlash(params.baseUrl)}/api/products/detail?${query.toString()}`;
  const raw = await getJson(url, params.headers, params.timeoutMs);
  const shopId = pickShopIdFromDetailPayload(raw);
  return { shopId, raw, url };
}

function getOrderNo(toolResp) {
  return firstString(
    toolResp?.order_no,
    toolResp?.data?.order_no,
    toolResp?.data?.data?.order_no,
    toolResp?.data?.data?.parent_order_no,
  );
}

function getShippingQuoteId(toolResp) {
  return firstString(
    toolResp?.shipping_quote_id,
    toolResp?.data?.shipping_quote_id,
  );
}

function getEscrowState(payload) {
  return firstString(
    payload?.escrow_state,
    payload?.proof?.escrow_state,
    payload?.data?.escrow_state,
    payload?.data?.proof?.escrow_state,
    payload?.data?.data?.escrow_state,
  );
}

function getTxRequest(payload) {
  return payload?.tx_request || payload?.data?.tx_request || null;
}

function selector(data) {
  const raw = String(data || '');
  if (raw.startsWith('0x') && raw.length >= 10) return raw.slice(0, 10);
  return raw.slice(0, 10);
}

function printStep(title) {
  console.log(`\n=== ${title} ===`);
}

function printJson(label, value) {
  console.log(`${label}: ${JSON.stringify(value, null, 2)}`);
}

function normalizeToolCallResult(rawResult) {
  if (!rawResult || typeof rawResult !== 'object') return rawResult;
  if (rawResult.structuredContent && typeof rawResult.structuredContent === 'object') {
    return rawResult.structuredContent;
  }
  const textContent = Array.isArray(rawResult.content)
    ? rawResult.content.find((item) => item && item.type === 'text' && typeof item.text === 'string')
    : null;
  if (textContent?.text) {
    try {
      return JSON.parse(textContent.text);
    } catch {
      return {
        success: rawResult.isError ? false : true,
        message: textContent.text,
      };
    }
  }
  if (rawResult.isError) {
    return {
      success: false,
      message: 'tools/call returned isError=true',
      raw: rawResult,
    };
  }
  return rawResult;
}

async function createStandardMcpClient(params) {
  let rpcId = 1;
  const rpcRequest = async (method, rpcParams, withId = true) => {
    const body = withId
      ? {
          jsonrpc: '2.0',
          id: rpcId++,
          method,
          params: rpcParams,
        }
      : {
          jsonrpc: '2.0',
          method,
          params: rpcParams,
        };
    const resp = await postJson(
      params.endpoint,
      body,
      params.headers,
      params.timeoutMs,
    );
    if (!withId) return {};
    if (!resp || typeof resp !== 'object') {
      throw new Error(`Invalid JSON-RPC response for ${method}`);
    }
    if (resp.error) {
      const code = resp.error?.code;
      const message = resp.error?.message || 'JSON-RPC error';
      throw new Error(`JSON-RPC ${code}: ${message}`);
    }
    return resp.result;
  };

  const initialize = await rpcRequest('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: {
      name: 'taopochta-mcp-flow-test',
      version: '1.0.0',
    },
  });
  await rpcRequest('notifications/initialized', {}, false);
  const toolsResult = await rpcRequest('tools/list', {});

  return {
    mode: 'standard',
    endpoint: params.endpoint,
    initialize,
    tools: toolsResult?.tools || [],
    async callTool(toolName, toolArgs) {
      printJson(`-> ${toolName} args`, toolArgs);
      const rawResult = await rpcRequest('tools/call', {
        name: toolName,
        arguments: toolArgs,
      });
      printJson(`<-${toolName} rpcResult`, rawResult);
      const normalized = normalizeToolCallResult(rawResult);
      printJson(`<-${toolName} normalized`, normalized);
      return normalized;
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (isTruthy(args.help) || isTruthy(args.h)) {
    console.log(`
Usage:
  node scripts/test-mcp-flow.js [--shippingAddressId 1] [options]

Core flow covered:
  1) MCP select product (search_products)
  2) MCP estimate shipping (estimate_shipping)
  3) MCP payment flow (create_order -> create_escrow -> fund_escrow)
  4) MCP query order status (get_order_proof)
  5) MCP change order status (confirm_receipt, optional submit_tx confirm)

Options:
  --baseUrl              API base url (default: https://taopochta.ru/api/mcp)
  --endpoint             MCP endpoint path/url (default: auto resolve /api/mcp)
  --tokenUrl             Token endpoint url (default: <apiBaseUrl>/api/mcp/token)
  --registerUrl          Client register endpoint (default: <apiBaseUrl>/api/mcp/clients/register)
  --interactive          Prompt for tx_hash when missing (default: true)
  --token                Bearer token. If omitted, script requests one from /api/mcp/token.
  --clientId             OAuth client id for token endpoint (or MCP_CLIENT_ID)
  --clientSecret         OAuth client secret for token endpoint (or MCP_CLIENT_SECRET)
  --bootstrapToken       Logged-in user bearer token (or MCP_BOOTSTRAP_USER_TOKEN) for self-register flow
  --autoRegisterClient   Auto call /api/mcp/clients/register when client credentials are missing (default: true)
  --registerClientId     Optional custom client_id for self-register
  --registerDisplayName  Optional display_name for self-register
  --registerScope        Optional scope for self-register (default: mcp:tools)
  --tokenTtlSec          Optional access token ttl_sec for /api/mcp/token
  --refreshTtlSec        Optional refresh_ttl_sec for /api/mcp/token
  --newUser              Auto-generate new userId when --token/--userId are absent (default: true)
  --userId               User ID for token/bootstrap. If omitted and --newUser=true, generated per run.
  --userName             Display name for MCP create_user bootstrap
  --keyword              Search keyword (default: earphones)
  --shippingAddressId    Optional. If omitted, script auto-picks/creates address via MCP.
  --autoCreateUser       Auto call MCP create_user when available (default: true)
  --autoCreateAddress    Auto call MCP create_address when available (default: true)
  --addressState         Default state when auto creating address (default: Moscow)
  --addressCity          Default city when auto creating address (default: Moscow)
  --addressStreet1       Default street_line1 when auto creating address (default: Tverskaya 1)
  --addressStreet2       Default street_line2 when auto creating address
  --addressDistrict      Default district when auto creating address
  --addressPostcode      Default postcode when auto creating address
  --addressCountryCode   Default country_code when auto creating address (default: RU)
  --addressCountryName   Default country_name when auto creating address (default: Russia)
  --recipientName        Default recipient_name when auto creating address
  --recipientPhone       Default recipient_phone when auto creating address
  --autoBindWallet       Auto call MCP set_buyer_wallet for BSC flow (default: true)
  --walletChainId        chain_id for wallet binding (default: 56)
  --quantity             Order quantity (default: 1)
  --payMethod            Payment method for create_order (default: bsc)
  --tokenSymbol          Payment token for escrow (default: USDT)
  --shopId               Optional override shop_id (skip auto pick from search result)
  --itemId               Optional override item_id
  --skuId                Optional override sku_id
  --itemResource         Item resource for detail fallback (default: taobao)
  --detailLanguage       Language for detail fallback (default: ru)
  --buyerWallet          buyer_wallet for create_escrow (required for bsc flow)
  --sellerWallet         Optional seller_wallet for create_escrow
  --createTxHash         Optional tx hash; if provided, will call submit_tx(action=create)
  --fundTxHash           Optional tx hash; if provided, will call submit_tx(action=fund)
  --confirmTxHash        Optional tx hash; if provided, will call submit_tx(action=confirm)
  --timeoutMs            HTTP timeout in ms (default: 30000)

Examples:
  node scripts/test-mcp-flow.js --shippingAddressId 1
  node scripts/test-mcp-flow.js --shippingAddressId 1 --keyword phone case
  node scripts/test-mcp-flow.js --shippingAddressId 1 --interactive true
  node scripts/test-mcp-flow.js --keyword earphones
  node scripts/test-mcp-flow.js --keyword earphones --createTxHash 0x...
  node scripts/test-mcp-flow.js --bootstrapToken eyJ...
  node scripts/test-mcp-flow.js --shippingAddressId 1 --endpoint /api/mcp/rpc
`);
    return;
  }

  const baseUrlInput = trimSlash(args.baseUrl || process.env.MCP_BASE_URL || 'https://taopochta.ru/api/mcp');
  const endpoint = resolveMcpEndpoint(
    baseUrlInput,
    firstString(args.endpoint, process.env.MCP_ENDPOINT),
  );
  const apiBaseUrl = deriveApiBaseUrl(baseUrlInput);
  const tokenUrl = firstString(
    args.tokenUrl,
    process.env.MCP_TOKEN_URL,
    `${apiBaseUrl}/api/mcp/token`,
  );
  const registerUrl = firstString(
    args.registerUrl,
    process.env.MCP_REGISTER_URL,
    `${apiBaseUrl}/api/mcp/clients/register`,
  );
  const interactive = isTruthy(firstString(args.interactive, process.env.MCP_INTERACTIVE, 'true'));
  const timeoutMs = toInt(args.timeoutMs || process.env.MCP_TIMEOUT_MS, 30000);
  const rawProvidedToken = firstString(args.token, process.env.MCP_TOKEN);
  const bootstrapToken = firstString(
    args.bootstrapToken,
    args.bootstrapUserToken,
    process.env.MCP_BOOTSTRAP_USER_TOKEN,
  );
  const autoRegisterClient = isTruthy(
    firstString(args.autoRegisterClient, process.env.MCP_AUTO_REGISTER_CLIENT, 'true'),
  );
  let clientId = firstString(args.clientId, process.env.MCP_CLIENT_ID);
  let clientSecret = firstString(args.clientSecret, process.env.MCP_CLIENT_SECRET);
  const registerClientId = firstString(args.registerClientId, process.env.MCP_REGISTER_CLIENT_ID);
  const registerDisplayName = firstString(
    args.registerDisplayName,
    process.env.MCP_REGISTER_DISPLAY_NAME,
  );
  const registerScope = firstString(args.registerScope, process.env.MCP_REGISTER_SCOPE);
  const tokenTtlSec = toInt(firstString(args.tokenTtlSec, process.env.MCP_ACCESS_TOKEN_TTL_SEC), 0);
  const refreshTtlSec = toInt(
    firstString(args.refreshTtlSec, process.env.MCP_REFRESH_TOKEN_TTL_SEC),
    0,
  );
  const newUser = isTruthy(firstString(args.newUser, process.env.MCP_NEW_USER, 'true'));
  const explicitUserId = toPositiveIntOrNaN(firstString(args.userId, process.env.MCP_USER_ID));
  const shippingAddressIdArg = toPositiveIntOrNaN(
    firstString(args.shippingAddressId, process.env.MCP_SHIPPING_ADDRESS_ID),
  );
  const autoCreateUser = isTruthy(firstString(args.autoCreateUser, process.env.MCP_AUTO_CREATE_USER, 'true'));
  const autoCreateAddress = isTruthy(
    firstString(args.autoCreateAddress, process.env.MCP_AUTO_CREATE_ADDRESS, 'true'),
  );
  const autoBindWallet = isTruthy(firstString(args.autoBindWallet, process.env.MCP_AUTO_BIND_WALLET, 'true'));
  const walletChainId = toInt(firstString(args.walletChainId, process.env.MCP_WALLET_CHAIN_ID, '56'), 56);
  let userId = Number.isFinite(explicitUserId) ? explicitUserId : 1;
  let userIdAutoGenerated = false;
  const tokenSub = rawProvidedToken ? decodeJwtSubUnsafe(rawProvidedToken) : NaN;
  const bootstrapSub = bootstrapToken ? decodeJwtSubUnsafe(bootstrapToken) : NaN;
  if (Number.isFinite(explicitUserId)) {
    userId = explicitUserId;
  } else if (!rawProvidedToken && Number.isFinite(bootstrapSub)) {
    userId = bootstrapSub;
  } else if (!rawProvidedToken && newUser) {
    userId = generateTestUserId();
    userIdAutoGenerated = true;
  } else if (Number.isFinite(tokenSub)) {
    userId = tokenSub;
  }
  if (rawProvidedToken && Number.isFinite(tokenSub) && Number.isFinite(explicitUserId) && tokenSub !== explicitUserId) {
    userId = tokenSub;
    console.log('[auth] token sub does not match --userId. Using token sub for MCP calls.');
  }
  if (!rawProvidedToken && Number.isFinite(bootstrapSub) && Number.isFinite(explicitUserId) && bootstrapSub !== explicitUserId) {
    userId = bootstrapSub;
    console.log('[auth] bootstrap token sub does not match --userId. Using bootstrap token sub for MCP calls.');
  }
  const userName = firstString(args.userName, process.env.MCP_USER_NAME, '');
  const addressState = firstString(args.addressState, process.env.MCP_ADDRESS_STATE, 'Moscow');
  const addressCity = firstString(args.addressCity, process.env.MCP_ADDRESS_CITY, 'Moscow');
  const addressStreet1 = firstString(args.addressStreet1, process.env.MCP_ADDRESS_STREET1, 'Tverskaya 1');
  const addressStreet2 = firstString(args.addressStreet2, process.env.MCP_ADDRESS_STREET2, '');
  const addressDistrict = firstString(args.addressDistrict, process.env.MCP_ADDRESS_DISTRICT, '');
  const addressPostcode = firstString(args.addressPostcode, process.env.MCP_ADDRESS_POSTCODE, '');
  const addressCountryCode = firstString(args.addressCountryCode, process.env.MCP_ADDRESS_COUNTRY_CODE, 'RU');
  const addressCountryName = firstString(args.addressCountryName, process.env.MCP_ADDRESS_COUNTRY_NAME, 'Russia');
  const recipientName = firstString(args.recipientName, process.env.MCP_RECIPIENT_NAME, '');
  const recipientPhone = firstString(args.recipientPhone, process.env.MCP_RECIPIENT_PHONE, '');
  const quantity = toInt(args.quantity || process.env.MCP_QUANTITY, 1);
  const keyword = firstString(args.keyword, process.env.MCP_KEYWORD, 'earphones');
  const payMethod = firstString(args.payMethod, process.env.MCP_PAY_METHOD, 'bsc');
  const isContractPayment = ['bsc', 'bsc_escrow'].includes(payMethod.toLowerCase());
  const tokenSymbol = firstString(args.tokenSymbol, process.env.MCP_TOKEN_SYMBOL, 'USDT').toUpperCase();
  const itemResource = firstString(args.itemResource, process.env.MCP_ITEM_RESOURCE, 'taobao');
  const detailLanguage = firstString(args.detailLanguage, process.env.MCP_DETAIL_LANGUAGE, 'ru');
  const buyerWallet = firstString(
    args.buyerWallet,
    process.env.MCP_BUYER_WALLET,
    DEFAULT_BUYER_WALLET,
  );
  const sellerWallet = firstString(args.sellerWallet, process.env.MCP_SELLER_WALLET);

  if (isContractPayment && !buyerWallet) {
    throw new Error('buyerWallet is required for BSC flow');
  }

  let token = rawProvidedToken;
  let tokenSource = rawProvidedToken ? 'provided' : '';
  if (!token) {
    if (!clientId || !clientSecret) {
      if (autoRegisterClient && bootstrapToken) {
        const registerResp = await registerMcpClient({
          registerUrl,
          bootstrapToken,
          clientId: registerClientId,
          displayName: registerDisplayName || `mcp_script_${userId}`,
          scope: registerScope,
          userId,
          ttlSec: tokenTtlSec,
          refreshTtlSec,
          timeoutMs,
        });
        clientId = registerResp.clientId;
        clientSecret = registerResp.clientSecret;
        token = registerResp.accessToken;
        printJson('[auth] registeredClient', {
          client_id: clientId,
          has_access_token: Boolean(token),
        });
        tokenSource = 'self_registered';
      } else {
        throw new Error(
          'MCP_TOKEN is not provided. Please set MCP_CLIENT_ID/MCP_CLIENT_SECRET or MCP_BOOTSTRAP_USER_TOKEN for self-register.',
        );
      }
    }
    if (!token) {
      if (!clientId || !clientSecret) {
        throw new Error('Failed to resolve client credentials for token issue.');
      }
      const tokenResp = await issueMcpToken({
        tokenUrl,
        clientId,
        clientSecret,
        userId,
        ttlSec: tokenTtlSec,
        refreshTtlSec,
        timeoutMs,
      });
      token = tokenResp.access_token;
      tokenSource = tokenSource || 'issued_by_server';
      console.log('[auth] token not provided, obtained access token from /api/mcp/token.');
    }
  }

  const headers = { authorization: `Bearer ${token}` };
  const mcp = await createStandardMcpClient({
    endpoint,
    headers,
    timeoutMs,
  });

  printStep('0. Basic Config');
  printJson('mode', mcp.mode);
  printJson('apiBaseUrl', apiBaseUrl);
  printJson('endpoint', mcp.endpoint);
  printJson('tokenUrl', tokenUrl);
  printJson('registerUrl', registerUrl);
  printJson('newUser', newUser);
  printJson('userId', userId);
  printJson('userIdAutoGenerated', userIdAutoGenerated);
  printJson('shippingAddressId(input)', Number.isFinite(shippingAddressIdArg) ? shippingAddressIdArg : null);
  printJson('autoCreateUser', autoCreateUser);
  printJson('autoCreateAddress', autoCreateAddress);
  printJson('autoBindWallet', autoBindWallet);
  printJson('walletChainId', walletChainId);
  printJson('keyword', keyword);
  printJson('payMethod', payMethod);
  printJson('tokenSymbol', tokenSymbol);
  printJson('itemResource', itemResource);
  printJson('detailLanguage', detailLanguage);
  printJson('interactive', interactive);
  printJson('tokenSource', tokenSource || 'issued_by_server');
  printJson('clientId', clientId || null);
  printJson('autoRegisterClient', autoRegisterClient);
  printJson('bootstrapTokenProvided', Boolean(bootstrapToken));
  printJson('buyerWallet', buyerWallet || null);
  printJson('initialize', mcp.initialize);
  printJson(
    'tools',
    Array.isArray(mcp.tools) ? mcp.tools.map((t) => t?.name).filter(Boolean) : [],
  );

  const availableTools = new Set(
    Array.isArray(mcp.tools) ? mcp.tools.map((t) => String(t?.name || '').trim()).filter(Boolean) : [],
  );

  let shippingAddressId = Number.isFinite(shippingAddressIdArg) ? shippingAddressIdArg : NaN;
  let addresses = [];

  printStep('0.1 MCP Bootstrap (create_user / create_address / set_buyer_wallet)');
  if (autoCreateUser) {
    if (availableTools.has('create_user')) {
      const createUserResp = await mcp.callTool('create_user', {
        user_id: userId,
        user_name: userName || `mcp_user_${userId}`,
      });
      ensureToolSuccess('create_user', createUserResp);
    } else {
      console.log('[bootstrap] create_user tool not found, skip.');
    }
  } else {
    console.log('[bootstrap] autoCreateUser=false, skip create_user.');
  }

  if (availableTools.has('list_addresses')) {
    const listAddressResp = await mcp.callTool('list_addresses', {});
    ensureToolSuccess('list_addresses', listAddressResp);
    addresses = extractAddresses(listAddressResp?.data || listAddressResp);
    printJson('addresses(before)', addresses);
    shippingAddressId = pickAddressId(addresses, shippingAddressId);
  } else {
    console.log('[bootstrap] list_addresses tool not found.');
  }

  if (!Number.isFinite(shippingAddressId) && autoCreateAddress) {
    if (availableTools.has('create_address')) {
      const createAddressResp = await mcp.callTool('create_address', {
        country_code: addressCountryCode,
        country_name: addressCountryName,
        state: addressState,
        city: addressCity,
        district: addressDistrict || undefined,
        street_line1: addressStreet1,
        street_line2: addressStreet2 || undefined,
        postcode: addressPostcode || undefined,
        recipient_name: recipientName || `MCP User ${userId}`,
        recipient_phone: recipientPhone || '+79990000000',
        is_default: true,
      });
      ensureToolSuccess('create_address', createAddressResp);
      const createdAddressId = toPositiveIntOrNaN(
        firstString(createAddressResp?.shipping_address_id, createAddressResp?.data?.id),
      );
      if (Number.isFinite(createdAddressId)) {
        shippingAddressId = createdAddressId;
      }
    } else {
      console.log('[bootstrap] create_address tool not found.');
    }
  }

  if (availableTools.has('list_addresses')) {
    const listAddressRespAfter = await mcp.callTool('list_addresses', {});
    ensureToolSuccess('list_addresses(after)', listAddressRespAfter);
    addresses = extractAddresses(listAddressRespAfter?.data || listAddressRespAfter);
    printJson('addresses(after)', addresses);
    shippingAddressId = pickAddressId(addresses, shippingAddressId);
  }

  if (isContractPayment) {
    let wallets = [];
    if (availableTools.has('list_wallets')) {
      const listWalletsResp = await mcp.callTool('list_wallets', { chain_id: walletChainId });
      ensureToolSuccess('list_wallets(before)', listWalletsResp);
      wallets = extractWallets(listWalletsResp?.data || listWalletsResp);
      printJson('wallets(before)', wallets);
    } else {
      console.log('[bootstrap] list_wallets tool not found.');
    }

    const currentPrimary = findPrimaryWallet(wallets, walletChainId);
    const currentPrimaryAddress = firstString(currentPrimary?.address).toLowerCase();
    const desiredBuyerWallet = firstString(buyerWallet).toLowerCase();
    const needsBind = !currentPrimaryAddress || (desiredBuyerWallet && currentPrimaryAddress !== desiredBuyerWallet);

    if (needsBind && autoBindWallet) {
      if (availableTools.has('set_buyer_wallet')) {
        const setWalletResp = await mcp.callTool('set_buyer_wallet', {
          address: buyerWallet,
          chain_id: walletChainId,
          is_primary: true,
          bind_method: 'injected',
        });
        ensureToolSuccess('set_buyer_wallet', setWalletResp);
      } else {
        console.log('[bootstrap] set_buyer_wallet tool not found.');
      }
    } else if (!autoBindWallet) {
      console.log('[bootstrap] autoBindWallet=false, skip set_buyer_wallet.');
    }

    if (availableTools.has('list_wallets')) {
      const listWalletsRespAfter = await mcp.callTool('list_wallets', { chain_id: walletChainId });
      ensureToolSuccess('list_wallets(after)', listWalletsRespAfter);
      wallets = extractWallets(listWalletsRespAfter?.data || listWalletsRespAfter);
      printJson('wallets(after)', wallets);
      const walletAfter = findPrimaryWallet(wallets, walletChainId);
      const walletAfterAddress = firstString(walletAfter?.address);
      if (!walletAfterAddress) {
        throw new Error(
          'No buyer wallet available for BSC flow. Bind wallet first or enable MCP set_buyer_wallet tool.',
        );
      }
    } else if (!availableTools.has('set_buyer_wallet')) {
      throw new Error(
        'BSC flow requires buyer wallet. MCP tools list_wallets/set_buyer_wallet are unavailable.',
      );
    }
  }

  if (!Number.isFinite(shippingAddressId)) {
    throw new Error(
      'shippingAddressId is not resolved. Provide --shippingAddressId, or enable MCP create_address tool for auto bootstrap.',
    );
  }
  printJson('shippingAddressId(resolved)', shippingAddressId);

  printStep('1. Select Product (MCP search_products)');
  const searchResp = await mcp.callTool('search_products', {
    keyword,
    page_no: 1,
    page_size: 10,
  });
  ensureToolSuccess('search_products', searchResp);

  const searchData = searchResp?.data || searchResp;
  const autoProduct = pickCheapestProduct(searchData) || pickFirstProduct(searchData);
  const autoFields = productToOrderFields(autoProduct);
  const autoProductPriceSummary = autoProduct
    ? {
        coupon_price: autoProduct?.coupon_price ?? autoProduct?.couponPrice ?? null,
        price: autoProduct?.price ?? null,
        selected_comparable_price: getComparableProductPrice(autoProduct),
      }
    : null;

  const orderFields = {
    shopId: firstString(args.shopId, autoFields?.shopId),
    itemId: firstString(args.itemId, autoFields?.itemId),
    skuId: firstString(args.skuId, autoFields?.skuId || ''),
    title: autoFields?.title || '(manual override)',
  };
  if (!orderFields.shopId && orderFields.itemId) {
    console.log('[select] shop_id missing in search result, trying /api/products/detail fallback...');
    try {
      const detailFallback = await resolveShopIdByDetail({
        baseUrl: apiBaseUrl,
        itemId: orderFields.itemId,
        itemResource,
        language: detailLanguage,
        headers,
        timeoutMs,
      });
      orderFields.shopId = firstString(orderFields.shopId, detailFallback.shopId);
      printJson('detailFallback', {
        item_id: orderFields.itemId,
        shop_id: orderFields.shopId || null,
        url: detailFallback.url,
      });
    } catch (err) {
      console.log(`[select] detail fallback failed: ${err?.message || err}`);
    }
  }
  if (!orderFields.shopId || !orderFields.itemId) {
    throw new Error(
      'Cannot resolve shop_id/item_id from search result (and detail fallback). Please provide --shopId and --itemId manually.',
    );
  }
  printJson('selectedProductPrice', autoProductPriceSummary);
  printJson('selectedProduct', orderFields);

  if (!availableTools.has('estimate_shipping')) {
    throw new Error('MCP tool estimate_shipping is required before create_order.');
  }
  printStep('2. Estimate Shipping (MCP estimate_shipping)');
  const estimateShippingResp = await mcp.callTool('estimate_shipping', {
    shipping_address_id: shippingAddressId,
    shop_id: orderFields.shopId,
    item_id: orderFields.itemId,
    sku_id: orderFields.skuId || undefined,
    quantity,
  });
  ensureToolSuccess('estimate_shipping', estimateShippingResp);
  const shippingQuoteId = getShippingQuoteId(estimateShippingResp);
  if (!shippingQuoteId) {
    throw new Error('estimate_shipping did not return shipping_quote_id');
  }
  printJson('shippingQuoteId', shippingQuoteId);
  printJson(
    'shippingEstimateTotals',
    estimateShippingResp?.data?.totals || estimateShippingResp?.data?.data?.totals || null,
  );
  printJson('paymentQuote', estimateShippingResp?.payment_quote || estimateShippingResp?.data?.payment_quote || null);

  printStep('3. Pay Flow (create_order -> create_escrow -> fund_escrow)');
  const createOrderResp = await mcp.callTool('create_order', {
    shipping_address_id: shippingAddressId,
    shop_id: orderFields.shopId,
    item_id: orderFields.itemId,
    sku_id: orderFields.skuId || undefined,
    quantity,
    shipping_quote_id: shippingQuoteId,
    pay_method: payMethod,
  });
  ensureToolSuccess('create_order', createOrderResp);
  const orderNo = getOrderNo(createOrderResp);
  if (!orderNo) throw new Error('create_order did not return order_no');
  printJson('orderNo', orderNo);

  const createEscrowArgs = {
    order_no: orderNo,
    token_symbol: tokenSymbol,
  };
  if (buyerWallet) createEscrowArgs.buyer_wallet = buyerWallet;
  if (sellerWallet) createEscrowArgs.seller_wallet = sellerWallet;
  const createEscrowResp = await mcp.callTool('create_escrow', createEscrowArgs);
  ensureToolSuccess('create_escrow', createEscrowResp);
  const createTxRequest = getTxRequest(createEscrowResp);
  const createStepRequired = Boolean(createTxRequest);
  printJson('createTxRequestSummary', {
    to: createTxRequest?.to || null,
    selector: selector(createTxRequest?.data || ''),
    next_action: firstString(createEscrowResp?.next_action, createEscrowResp?.data?.next_action),
  });
  if (createStepRequired) {
    printJson('createTxRequest', createTxRequest);
  }

  let createTxHash = firstString(args.createTxHash);
  if (createStepRequired) {
    if (!createTxHash) {
      if (interactive) {
        console.log('[payment] Please send CREATE escrow transaction in MetaMask using createTxRequest.');
        createTxHash = await askTxHash('create', interactive);
      }
    } else if (!isTxHash(createTxHash)) {
      throw new Error('createTxHash format invalid. Expected 0x + 64 hex chars.');
    }
  }
  let createSubmitResp = null;
  if (createStepRequired) {
    if (!createTxHash) {
      throw new Error(
        'Escrow create tx hash is required before fund_escrow. Provide --createTxHash or run with --interactive true.',
      );
    }
    createSubmitResp = await mcp.callTool('submit_tx', {
      order_no: orderNo,
      action: 'create',
      tx_hash: createTxHash,
    });
    ensureToolSuccess('submit_tx(create)', createSubmitResp);
  }

  const fundResp = await mcp.callTool('fund_escrow', {
    order_no: orderNo,
    token_symbol: tokenSymbol,
  });
  ensureToolSuccess('fund_escrow', fundResp);
  const fundTxRequest = getTxRequest(fundResp);
  const approveTxRequest = fundResp?.approve_tx_request || fundResp?.data?.approve_tx_request || null;
  const needsApproval = Boolean(fundResp?.needs_approval || fundResp?.data?.needs_approval);
  printJson('fundTxRequestSummary', {
    to: fundTxRequest?.to || null,
    selector: selector(fundTxRequest?.data || ''),
    needs_approval: needsApproval,
    next_action: firstString(fundResp?.next_action, fundResp?.data?.next_action),
  });
  if (needsApproval && approveTxRequest) {
    printJson('approveTxRequest', approveTxRequest);
  }
  if (fundTxRequest) {
    printJson('fundTxRequest', fundTxRequest);
  }

  let fundTxHash = firstString(args.fundTxHash);
  if (!fundTxHash) {
    if (interactive) {
      if (needsApproval) {
        console.log(
          '[payment] Please send APPROVE transaction in MetaMask first (approveTxRequest), then send FUND transaction (fundTxRequest).',
        );
      } else {
        console.log('[payment] Please send FUND transaction in MetaMask using fundTxRequest.');
      }
      fundTxHash = await askTxHash('fund', interactive);
    }
  } else if (!isTxHash(fundTxHash)) {
    throw new Error('fundTxHash format invalid. Expected 0x + 64 hex chars.');
  }
  let fundSubmitResp = null;
  if (fundTxHash) {
    fundSubmitResp = await mcp.callTool('submit_tx', {
      order_no: orderNo,
      action: 'fund',
      tx_hash: fundTxHash,
    });
    ensureToolSuccess('submit_tx(fund)', fundSubmitResp);
  } else {
    console.log('[payment] fundTxHash not provided, skipped submit_tx(action=fund).');
  }

  printStep('4. Query Order Status (MCP get_order_proof)');
  const proofBeforeChange = await mcp.callTool('get_order_proof', {
    order_no: orderNo,
  });
  ensureToolSuccess('get_order_proof(before)', proofBeforeChange);
  const stateBeforeChange = getEscrowState(proofBeforeChange);
  printJson('stateBeforeChange', stateBeforeChange || '(empty)');

  printStep('5. Change Order Status (MCP confirm_receipt)');
  const confirmReqResp = await mcp.callTool('confirm_receipt', {
    order_no: orderNo,
  });
  ensureToolSuccess('confirm_receipt', confirmReqResp);
  const confirmTxRequest = getTxRequest(confirmReqResp);
  printJson('confirmTxRequestSummary', {
    to: confirmTxRequest?.to || null,
    selector: selector(confirmTxRequest?.data || ''),
    next_action: firstString(confirmReqResp?.next_action, confirmReqResp?.data?.next_action),
  });
  if (confirmTxRequest) {
    printJson('confirmTxRequest', confirmTxRequest);
  }

  let confirmTxHash = firstString(args.confirmTxHash);
  if (!confirmTxHash) {
    if (interactive) {
      console.log('[status-change] Please send CONFIRM transaction in MetaMask using confirmTxRequest.');
      confirmTxHash = await askTxHash('confirm', interactive);
    }
  } else if (!isTxHash(confirmTxHash)) {
    throw new Error('confirmTxHash format invalid. Expected 0x + 64 hex chars.');
  }
  let confirmSubmitResp = null;
  if (confirmTxHash) {
    confirmSubmitResp = await mcp.callTool('submit_tx', {
      order_no: orderNo,
      action: 'confirm',
      tx_hash: confirmTxHash,
    });
    ensureToolSuccess('submit_tx(confirm)', confirmSubmitResp);
  } else {
    console.log('[status-change] confirmTxHash not provided, skipped submit_tx(action=confirm).');
  }

  const proofAfterChange = await mcp.callTool('get_order_proof', {
    order_no: orderNo,
  });
  ensureToolSuccess('get_order_proof(after)', proofAfterChange);
  const stateAfterChange = getEscrowState(proofAfterChange);

  printStep('Done');
  printJson('summary', {
    order_no: orderNo,
    shipping_quote_id: shippingQuoteId,
    shipping_address_id: shippingAddressId,
    buyer_wallet: buyerWallet || null,
    selected_product: orderFields,
    payment_quote: estimateShippingResp?.payment_quote || estimateShippingResp?.data?.payment_quote || null,
    create_escrow_state: getEscrowState(createEscrowResp),
    state_before_change: stateBeforeChange || null,
    state_after_change: stateAfterChange || null,
    submit_create_executed: Boolean(createSubmitResp),
    submit_fund_executed: Boolean(fundSubmitResp),
    submit_confirm_executed: Boolean(confirmSubmitResp),
    note:
      (createStepRequired && !createTxHash) || !fundTxHash || !confirmTxHash
        ? 'No tx hash provided for at least one submit_tx step; on-chain state may remain unchanged.'
        : 'create/fund/confirm submit_tx were executed.',
  });
}

main().catch((err) => {
  console.error('\n[ERROR]', err?.message || err);
  process.exit(1);
});
