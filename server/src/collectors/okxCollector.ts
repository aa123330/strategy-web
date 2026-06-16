import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ProxyAgent } from "undici";
import type { CandleInput, Interval } from "../types";
import { upsertCandles } from "../db";

const OKX_BASE = "https://www.okx.com";
const OKX_LIMIT = 100;
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
const execFileAsync = promisify(execFile);

const SYMBOL_MAP: Record<string, string> = {
  BTC_USDT: "BTC-USDT-SWAP",
  ETH_USDT: "ETH-USDT-SWAP",
  SOL_USDT: "SOL-USDT-SWAP",
  BNB_USDT: "BNB-USDT-SWAP",
};

const INTERVAL_MAP: Record<Interval, string> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "1h": "1H",
  "4h": "4H",
  "1d": "1D",
};

interface OkxCandlesResponse {
  code: string;
  msg: string;
  data: string[][];
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeOkxCandle(symbol: string, interval: Interval, item: string[]): CandleInput {
  const open = Number(item[1]);
  const close = Number(item[4]);
  return {
    exchange: "okx",
    symbol,
    interval,
    time: Math.floor(Number(item[0]) / 1000),
    open,
    high: Number(item[2]),
    low: Number(item[3]),
    close,
    volume: Number(item[5]),
    turnover: item[7] !== undefined ? Number(item[7]) : null,
  };
}

async function fetchWithCurl(url: URL): Promise<OkxCandlesResponse> {
  const { stdout } = await execFileAsync("curl", ["--max-time", "20", "-s", url.toString()], { maxBuffer: 1024 * 1024 * 5 });
  return JSON.parse(stdout) as OkxCandlesResponse;
}

async function fetchWithRetry(url: URL, retries = 3): Promise<OkxCandlesResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      let json: OkxCandlesResponse;
      try {
        const resp = await fetch(url.toString(), { headers: { Accept: "application/json" }, dispatcher });
        if (!resp.ok) throw new Error(`OKX candles HTTP ${resp.status}`);
        json = (await resp.json()) as OkxCandlesResponse;
      } catch {
        json = await fetchWithCurl(url);
      }
      if (json.code !== "0" || !Array.isArray(json.data)) throw new Error(`OKX candles invalid ${json.code}: ${json.msg}`);
      return json;
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(500 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function fetchOkxCandles(params: {
  symbol: string;
  interval: Interval;
  afterMs?: number;
  beforeMs?: number;
  limit?: number;
}): Promise<CandleInput[]> {
  const instId = SYMBOL_MAP[params.symbol] ?? params.symbol.replace(/_/g, "-");
  const url = new URL("/api/v5/market/history-candles", OKX_BASE);
  url.searchParams.set("instId", instId);
  url.searchParams.set("bar", INTERVAL_MAP[params.interval]);
  url.searchParams.set("limit", String(Math.min(params.limit ?? OKX_LIMIT, OKX_LIMIT)));
  if (params.afterMs) url.searchParams.set("after", String(params.afterMs));
  if (params.beforeMs) url.searchParams.set("before", String(params.beforeMs));

  const json = await fetchWithRetry(url);
  return json.data.map((item) => normalizeOkxCandle(params.symbol, params.interval, item)).sort((a, b) => a.time - b.time);
}

export async function backfillOkxCandles(params: {
  symbols: string[];
  intervals: Interval[];
  days: number;
  onProgress?: (message: string) => void;
}) {
  const minTimeMs = Date.now() - params.days * 86400 * 1000;
  let inserted = 0;

  for (const symbol of params.symbols) {
    for (const interval of params.intervals) {
      let afterMs: number | undefined;
      let page = 0;
      params.onProgress?.(`开始补全 OKX ${symbol} ${interval}`);

      while (true) {
        const candles = await fetchOkxCandles({ symbol, interval, afterMs, limit: OKX_LIMIT });
        if (!candles.length) break;

        const useful = candles.filter((c) => c.time * 1000 >= minTimeMs);
        inserted += upsertCandles(useful);
        page += 1;
        params.onProgress?.(`OKX ${symbol} ${interval} page ${page} +${useful.length}`);

        const oldest = candles[0];
        afterMs = oldest.time * 1000;
        if (oldest.time * 1000 <= minTimeMs) break;
        await sleep(160);
      }
    }
  }

  return { inserted };
}
