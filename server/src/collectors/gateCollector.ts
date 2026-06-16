import type { CandleInput, Interval } from "../types";
import { upsertCandles } from "../db";

const GATE_BASE = "https://api.gateio.ws/api/v4/futures/usdt";
const SYMBOL_MAP: Record<string, string> = {
  BTC_USDT: "BTC_USDT",
  ETH_USDT: "ETH_USDT",
  SOL_USDT: "SOL_USDT",
  BNB_USDT: "BNB_USDT",
};

const INTERVAL_SECONDS: Record<Interval, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
};

interface GateCandleRow {
  t: number | string;
  o: number | string;
  h: number | string;
  l: number | string;
  c: number | string;
  v: number | string;
  a?: number | string;
  sum?: number | string;
}

function normalizeGateCandle(symbol: string, interval: Interval, row: GateCandleRow): CandleInput {
  return {
    exchange: "gate",
    symbol,
    interval,
    time: Number(row.t),
    open: Number(row.o),
    high: Number(row.h),
    low: Number(row.l),
    close: Number(row.c),
    volume: Number(row.v),
    turnover: row.a !== undefined ? Number(row.a) : row.sum !== undefined ? Number(row.sum) : null,
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchGateCandles(params: {
  symbol: string;
  interval: Interval;
  from?: number;
  to?: number;
  limit?: number;
}): Promise<CandleInput[]> {
  const contract = SYMBOL_MAP[params.symbol] ?? params.symbol;
  const url = new URL(`${GATE_BASE}/candlesticks`);
  url.searchParams.set("contract", contract);
  url.searchParams.set("interval", params.interval);
  if (params.from) url.searchParams.set("from", String(params.from));
  if (params.to) url.searchParams.set("to", String(params.to));
  if (!params.from && !params.to) url.searchParams.set("limit", String(Math.min(params.limit ?? 1000, 1000)));

  const resp = await fetch(url, { headers: { Accept: "application/json" } });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`Gate candles HTTP ${resp.status}${detail ? `: ${detail}` : ""}`);
  }
  const data = await resp.json();
  if (!Array.isArray(data)) throw new Error("Gate candles response invalid");
  return data.map((row) => normalizeGateCandle(params.symbol, params.interval, row)).sort((a, b) => a.time - b.time);
}

export async function backfillGateCandles(params: {
  symbols: string[];
  intervals: Interval[];
  days: number;
  onProgress?: (message: string) => void;
}) {
  const now = Math.floor(Date.now() / 1000);
  const from = now - params.days * 86400;
  let inserted = 0;

  for (const symbol of params.symbols) {
    for (const interval of params.intervals) {
      const step = INTERVAL_SECONDS[interval] * 999;
      let cursor = from;
      params.onProgress?.(`开始补全 ${symbol} ${interval}`);

      while (cursor < now) {
        const to = Math.min(cursor + step, now);
        const candles = await fetchGateCandles({ symbol, interval, from: cursor, to, limit: 1000 });
        inserted += upsertCandles(candles);
        params.onProgress?.(`${symbol} ${interval} ${new Date(cursor * 1000).toISOString()} +${candles.length}`);
        cursor = to + INTERVAL_SECONDS[interval];
        await sleep(120);
      }
    }
  }

  return { inserted };
}
