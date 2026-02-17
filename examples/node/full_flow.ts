/* eslint-disable no-console */
import crypto from 'crypto';

const DEFAULT_BUYER_WALLET = '';

type JsonRpcResult = {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: any;
  isError?: boolean;
};

function trimSlash(input: string): string {
  return String(input || '').replace(/\/+$/, '');
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function base64Url(input: string): string {
  return Buffer.from(input).toString('base64url');
}

function makeToken(userId: number, secret: string): string {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(
    JSON.stringify({
      sub: userId,
      iat: nowSec(),
      exp: nowSec() + 3600,
    }),
  );
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const s = String(value ?? '').trim();
    if (s) return s;
  }
  return '';
}

function toInt(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function parseToolResult(raw: JsonRpcResult): any {
  if (raw?.structuredContent && typeof raw.structuredContent === 'object') {
    return raw.structuredContent;
  }
  const text = raw?.content?.find((it) => it?.type === 'text' && typeof it?.text === 'string')?.text;
  if (!text) return raw;
  try {
    return JSON.parse(text);
  } catch {
    return { success: raw?.isError ? false : true, message: text };
  }
}

function ensureToolSuccess(step: string, payload: any): void {
  if (payload && payload.success === false) {
    throw new Error(`${step} failed: ${payload.error || payload.message || 'unknown error'}`);
  }
}

function collectArrays(node: any, out: any[], depth = 0): void {
  if (depth > 6 || node == null) return;
  if (Array.isArray(node)) {
    out.push(node);
    for (const item of node) collectArrays(item, out, depth + 1);
    return;
  }
  if (typeof node === 'object') {
    for (const key of Object.keys(node)) collectArrays(node[key], out, depth + 1);
  }
}

function toPriceNumber(raw: any): number | null {
  if (raw == null || raw === '') return null;
  const n = Number(String(raw).replace(/,/g, '').trim());
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function getComparablePrice(product: any): number | null {
  const coupon = toPriceNumber(product?.coupon_price ?? product?.couponPrice);
  const price = toPriceNumber(product?.price);
  if (coupon != null && price != null) return Math.min(coupon, price);
  if (coupon != null) return coupon;
  if (price != null) return price;
  return null;
}

function looksLikeProduct(item: any): boolean {
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

function getSkuId(product: any): string {
  return firstString(
    product?.sku_id,
    product?.skuId,
    product?.default_sku_id,
    product?.defaultSkuId,
    product?.sku,
  );
}

function pickCheapestProduct(payload: any): any {
  const arrays: any[] = [];
  collectArrays(payload, arrays);
  const products: any[] = [];
  for (const arr of arrays) {
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (looksLikeProduct(item)) products.push(item);
    }
  }
  let best: any = null;
  let bestPrice = Number.POSITIVE_INFINITY;
  for (const product of products) {
    const p = getComparablePrice(product);
    if (p == null) continue;
    if (p < bestPrice) {
      bestPrice = p;
      best = product;
    }
  }
  return best || products[0] || null;
}

function extractAddresses(payload: any): any[] {
  const arrays: any[] = [];
  collectArrays(payload, arrays);
  for (const arr of arrays) {
    if (!Array.isArray(arr)) continue;
    const matches = arr.filter((it) => Number.isFinite(Number(it?.id)));
    if (matches.length) return matches;
  }
  return [];
}

function getOrderNo(payload: any): string {
  return firstString(
    payload?.order_no,
    payload?.data?.order_no,
    payload?.data?.data?.order_no,
    payload?.result?.structuredContent?.order_no,
  );
}

function getShippingQuoteId(payload: any): string {
  return firstString(payload?.shipping_quote_id, payload?.data?.shipping_quote_id);
}

function getTxRequest(payload: any): any {
  return payload?.tx_request || payload?.data?.tx_request || null;
}

class McpClient {
  private id = 1;

  constructor(
    private readonly endpoint: string,
    private readonly token: string,
  ) {}

  private async post(body: any): Promise<any> {
    const resp = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    const json = text ? JSON.parse(text) : {};
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${text}`);
    }
    return json;
  }

  async rpc(method: string, params: any, withId = true): Promise<any> {
    const body = withId
      ? { jsonrpc: '2.0', id: this.id++, method, params }
      : { jsonrpc: '2.0', method, params };
    const result = await this.post(body);
    if (!withId) return {};
    if (result?.error) {
      throw new Error(`JSON-RPC ${result.error.code}: ${result.error.message}`);
    }
    return result?.result;
  }

  async callTool(name: string, args: Record<string, any>): Promise<any> {
    const raw: JsonRpcResult = await this.rpc('tools/call', { name, arguments: args });
    const normalized = parseToolResult(raw);
    ensureToolSuccess(name, normalized);
    return normalized;
  }
}

async function resolveShopIdByDetail(
  baseUrl: string,
  token: string,
  itemId: string,
  itemResource: string,
  language: string,
): Promise<string> {
  const url = `${trimSlash(baseUrl)}/api/products/detail?item_resource=${encodeURIComponent(
    itemResource,
  )}&item_id=${encodeURIComponent(itemId)}&language=${encodeURIComponent(language)}`;
  const resp = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
    },
  });
  const json = await resp.json();
  return firstString(
    json?.shop_id,
    json?.shopId,
    json?.data?.shop_id,
    json?.data?.shopId,
    json?.data?.data?.shop_id,
    json?.data?.data?.shopId,
  );
}

async function main(): Promise<void> {
  const baseUrl = trimSlash(process.env.MCP_BASE_URL || 'https://taopochta.ru');
  const endpoint = `${baseUrl}${(process.env.MCP_ENDPOINT || '/api/mcp').startsWith('/') ? '' : '/'}${
    process.env.MCP_ENDPOINT || '/api/mcp'
  }`;
  const userId = toInt(process.env.MCP_USER_ID || Date.now(), Date.now());
  const token = process.env.MCP_TOKEN || makeToken(userId, process.env.AUTH_TOKEN_SECRET || 'dev-secret');
  const keyword = process.env.MCP_KEYWORD || 'watercup';
  const payMethod = process.env.MCP_PAY_METHOD || 'bsc';
  const tokenSymbol = (process.env.MCP_TOKEN_SYMBOL || 'USDT').toUpperCase();
  const buyerWallet = process.env.MCP_BUYER_WALLET || DEFAULT_BUYER_WALLET;
  const quantity = toInt(process.env.MCP_QUANTITY || 1, 1);
  const itemResource = process.env.MCP_ITEM_RESOURCE || 'taobao';
  const detailLanguage = process.env.MCP_DETAIL_LANGUAGE || 'ru';
  const createTxHash = firstString(process.env.CREATE_TX_HASH);
  const fundTxHash = firstString(process.env.FUND_TX_HASH);
  const confirmTxHash = firstString(process.env.CONFIRM_TX_HASH);

  if (payMethod.toLowerCase() === 'bsc' && !buyerWallet) {
    throw new Error('MCP_BUYER_WALLET is required for bsc flow');
  }

  const mcp = new McpClient(endpoint, token);

  console.log('== initialize ==');
  const init = await mcp.rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'node-full-flow', version: '1.0.0' },
  });
  console.log(JSON.stringify(init, null, 2));
  await mcp.rpc('notifications/initialized', {}, false);

  const tools = await mcp.rpc('tools/list', {});
  const toolNames = (tools?.tools || []).map((t: any) => t?.name).filter(Boolean);
  console.log('tools:', toolNames);
  const has = (name: string) => toolNames.includes(name);

  if (has('create_user')) {
    await mcp.callTool('create_user', {
      user_id: userId,
      user_name: `mcp_user_${userId}`,
    });
  }

  let shippingAddressId = toInt(process.env.MCP_SHIPPING_ADDRESS_ID, NaN);
  if (!Number.isFinite(shippingAddressId) && has('list_addresses')) {
    const list = await mcp.callTool('list_addresses', {});
    const addresses = extractAddresses(list?.data || list);
    shippingAddressId = toInt(
      addresses.find((a: any) => a?.is_default)?.id || addresses[0]?.id,
      NaN,
    );
  }
  if (!Number.isFinite(shippingAddressId) && has('create_address')) {
    const createAddress = await mcp.callTool('create_address', {
      country_code: 'RU',
      country_name: 'Russia',
      state: 'Moscow',
      city: 'Moscow',
      street_line1: 'Tverskaya 1',
      recipient_name: `MCP User ${userId}`,
      recipient_phone: '+79990000000',
      is_default: true,
    });
    shippingAddressId = toInt(firstString(createAddress?.shipping_address_id, createAddress?.data?.id), NaN);
  }
  if (!Number.isFinite(shippingAddressId)) {
    throw new Error('Cannot resolve shipping_address_id');
  }
  console.log('shipping_address_id:', shippingAddressId);

  if (payMethod.toLowerCase() === 'bsc' && has('set_buyer_wallet')) {
    await mcp.callTool('set_buyer_wallet', {
      address: buyerWallet,
      chain_id: 56,
      is_primary: true,
      bind_method: 'injected',
    });
  }

  console.log('== search_products ==');
  const searchResp = await mcp.callTool('search_products', {
    keyword,
    page_no: 1,
    page_size: 10,
  });
  const searchPayload = searchResp?.data || searchResp;
  const selected = pickCheapestProduct(searchPayload);
  if (!selected) throw new Error('No product found');

  const itemId = firstString(selected?.item_id, selected?.itemId);
  let shopId = firstString(selected?.shop_id, selected?.shopId, process.env.MCP_SHOP_ID);
  const skuId = firstString(process.env.MCP_SKU_ID, getSkuId(selected));
  if (!itemId) throw new Error('No item_id in selected product');
  if (!shopId) {
    shopId = await resolveShopIdByDetail(baseUrl, token, itemId, itemResource, detailLanguage);
  }
  if (!shopId) throw new Error('Cannot resolve shop_id');
  console.log('selected:', {
    itemId,
    shopId,
    sku_id: skuId || null,
    coupon_price: selected?.coupon_price ?? null,
    price: selected?.price ?? null,
  });

  console.log('== estimate_shipping ==');
  const estimateResp = await mcp.callTool('estimate_shipping', {
    shipping_address_id: shippingAddressId,
    shop_id: shopId,
    item_id: itemId,
    sku_id: skuId || undefined,
    quantity,
  });
  const shippingQuoteId = getShippingQuoteId(estimateResp);
  if (!shippingQuoteId) throw new Error('estimate_shipping did not return shipping_quote_id');
  console.log('shipping_quote_id:', shippingQuoteId);
  console.log('payment_quote:', estimateResp?.payment_quote || estimateResp?.data?.payment_quote || null);

  console.log('== create_order ==');
  const createOrderResp = await mcp.callTool('create_order', {
    shipping_address_id: shippingAddressId,
    shop_id: shopId,
    item_id: itemId,
    sku_id: skuId || undefined,
    quantity,
    shipping_quote_id: shippingQuoteId,
    pay_method: payMethod,
  });
  const orderNo = getOrderNo(createOrderResp);
  if (!orderNo) throw new Error('create_order did not return order_no');
  console.log('order_no:', orderNo);

  console.log('== create_escrow ==');
  const createEscrowResp = await mcp.callTool('create_escrow', {
    order_no: orderNo,
    token_symbol: tokenSymbol,
    buyer_wallet: buyerWallet,
  });
  console.log('create_escrow:', JSON.stringify(createEscrowResp, null, 2));
  const createTxRequest = getTxRequest(createEscrowResp);
  if (createTxRequest) {
    console.log('create_tx_request:', createTxRequest);
  }
  if (createTxHash) {
    const createSubmit = await mcp.callTool('submit_tx', {
      order_no: orderNo,
      action: 'create',
      tx_hash: createTxHash,
    });
    console.log('submit_tx(create):', JSON.stringify(createSubmit, null, 2));
  }

  console.log('== fund_escrow ==');
  const fundResp = await mcp.callTool('fund_escrow', {
    order_no: orderNo,
    token_symbol: tokenSymbol,
  });
  console.log('fund_escrow:', JSON.stringify(fundResp, null, 2));
  if (fundTxHash) {
    const fundSubmit = await mcp.callTool('submit_tx', {
      order_no: orderNo,
      action: 'fund',
      tx_hash: fundTxHash,
    });
    console.log('submit_tx(fund):', JSON.stringify(fundSubmit, null, 2));
  }

  console.log('== confirm_receipt ==');
  const confirmResp = await mcp.callTool('confirm_receipt', { order_no: orderNo });
  console.log('confirm_receipt:', JSON.stringify(confirmResp, null, 2));
  if (confirmTxHash) {
    const confirmSubmit = await mcp.callTool('submit_tx', {
      order_no: orderNo,
      action: 'confirm',
      tx_hash: confirmTxHash,
    });
    console.log('submit_tx(confirm):', JSON.stringify(confirmSubmit, null, 2));
  }

  console.log('== get_order_proof ==');
  const proof = await mcp.callTool('get_order_proof', { order_no: orderNo });
  console.log(JSON.stringify(proof, null, 2));

  console.log('== summary ==');
  console.log(
    JSON.stringify(
      {
        order_no: orderNo,
        shipping_quote_id: shippingQuoteId,
        item_id: itemId,
        shop_id: shopId,
        sku_id: skuId || null,
        create_submitted: Boolean(createTxHash),
        fund_submitted: Boolean(fundTxHash),
        confirm_submitted: Boolean(confirmTxHash),
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error('[ERROR]', err?.message || err);
  process.exit(1);
});

