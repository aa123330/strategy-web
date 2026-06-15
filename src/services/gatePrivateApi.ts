import { BASE_URL, signRequest } from "./gateSignature";

export interface Account {
  total: string;
  currency: string;
  available: string;
}

export interface Position {
  contract: string;
  size: number;
  entry_price: string;
  mark_price: string;
  liq_price: string;
  leverage: string;
  realized_pnl: string;
  unrealised_pnl: string;
}

export interface OrderRequest {
  contract: string;
  size: string;
  price: string;
  tif: "ioc" | "gtc" | "poc";
  reduce_only: boolean;
  text?: string;
}

export interface OrderResponse {
  id: string;
  contract: string;
  size: string;
  price: string;
  tif: string;
  reduce_only: boolean;
  is_reduce_only: boolean;
  fill_price: string;
  status: string;
  finish_as: string;
  text: string;
  created_at: number;
  updated_at: number;
}

async function privateRequest(
  method: "GET" | "POST" | "DELETE",
  path: string,
  key: string,
  secret: string,
  query: Record<string, string> = {},
  body: unknown = null
): Promise<Response> {
  const { timestamp, signature } = await signRequest(method, path, query, body, secret);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    KEY: key,
    Timestamp: timestamp,
    SIGN: signature,
    "X-Gate-Size-Decimal": "1",
  };
  const queryString = new URLSearchParams(query).toString();
  const url = `${BASE_URL}${path}${queryString ? "?" + queryString : ""}`;
  const init: RequestInit = {
    method,
    headers,
  };
  if (body && method !== "GET") {
    init.body = JSON.stringify(body);
  }
  return fetch(url, init);
}

export async function getFuturesAccount(key: string, secret: string): Promise<Account | null> {
  try {
    const resp = await privateRequest("GET", "/futures/usdt/accounts", key, secret);
    if (!resp.ok) return null;
    return resp.json();
  } catch {
    return null;
  }
}

export async function getPosition(key: string, secret: string, symbol = "ETH_USDT"): Promise<Position | null> {
  try {
    const resp = await privateRequest("GET", `/futures/usdt/positions/${symbol}`, key, secret);
    if (!resp.ok) return null;
    return resp.json();
  } catch {
    return null;
  }
}

export async function createOrder(key: string, secret: string, order: OrderRequest): Promise<OrderResponse | null> {
  const resp = await privateRequest("POST", "/futures/usdt/orders", key, secret, {}, order);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.message || `HTTP ${resp.status}`);
  }
  return resp.json();
}
