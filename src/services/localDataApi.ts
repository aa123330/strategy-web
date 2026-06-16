import type { CandleRow } from "./gatePublicApi";

export interface CandleRange {
  minTime: number | null;
  maxTime: number | null;
  count: number;
}

export interface LocalCandlesResponse {
  exchange: string;
  symbol: string;
  interval: string;
  range: CandleRange;
  candles: Array<{
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    turnover: number | null;
  }>;
}

export interface BacktestMetrics {
  candles: number;
  trades: number;
  winRate: number;
  totalReturn: number;
  averageReturn: number;
  profitFactor: number;
  maxDrawdown: number;
  maxConsecutiveLosses: number;
}

export interface BacktestResult {
  ok: true;
  exchange?: string;
  symbol: string;
  interval: string;
  strategy?: "dual_ma" | "sma_rsi_pullback";
  split: {
    train: { metrics: BacktestMetrics };
    test: { metrics: BacktestMetrics };
  };
}

const LOCAL_API_BASE = "/local-api";

export function normalizeLocalCandle(row: LocalCandlesResponse["candles"][number]): CandleRow {
  return {
    time: row.time,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    is_ascending: row.close >= row.open,
    turnover: String(row.turnover ?? "0"),
  };
}

export async function getLocalCandles(params: {
  exchange?: string;
  symbol?: string;
  interval: string;
  limit?: number;
}): Promise<LocalCandlesResponse | null> {
  try {
    const url = new URL(`${LOCAL_API_BASE}/candles`, window.location.origin);
    url.searchParams.set("exchange", params.exchange ?? "gate");
    url.searchParams.set("symbol", params.symbol ?? "ETH_USDT");
    url.searchParams.set("interval", params.interval);
    url.searchParams.set("limit", String(params.limit ?? 5000));
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return (await resp.json()) as LocalCandlesResponse;
  } catch {
    return null;
  }
}

export interface BackfillJob {
  id: string;
  exchange: string;
  symbols: string[];
  intervals: string[];
  days: number;
  status: "running" | "completed" | "failed";
  inserted: number;
  messages: string[];
  currentMessage: string;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface BackfillResult {
  ok: true;
  job: BackfillJob;
}

export async function backfillLocalCandles(params: {
  exchange: string;
  symbols?: string[];
  intervals?: string[];
  days?: number;
}): Promise<BackfillResult | null> {
  try {
    const resp = await fetch(`${LOCAL_API_BASE}/backfill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        exchange: params.exchange,
        symbols: params.symbols ?? ["ETH_USDT", "BTC_USDT"],
        intervals: params.intervals ?? ["15m", "1h"],
        days: params.days ?? 30,
      }),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as BackfillResult;
  } catch {
    return null;
  }
}

export async function getBackfillJob(id: string): Promise<BackfillResult | null> {
  try {
    const resp = await fetch(`${LOCAL_API_BASE}/backfill/${id}`);
    if (!resp.ok) return null;
    return (await resp.json()) as BackfillResult;
  } catch {
    return null;
  }
}

export async function runBacktest(params: {
  exchange?: string;
  symbol?: string;
  interval: string;
  strategy?: "dual_ma" | "sma_rsi_pullback";
  fastPeriod: number;
  slowPeriod: number;
  rsiPeriod?: number;
  longRsiMax?: number;
  shortRsiMin?: number;
}): Promise<BacktestResult | null> {
  try {
    const resp = await fetch(`${LOCAL_API_BASE}/backtest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        exchange: params.exchange ?? "gate",
        symbol: params.symbol ?? "ETH_USDT",
        interval: params.interval,
        params: {
          strategy: params.strategy,
          fastPeriod: params.fastPeriod,
          slowPeriod: params.slowPeriod,
          rsiPeriod: params.rsiPeriod,
          longRsiMax: params.longRsiMax,
          shortRsiMin: params.shortRsiMin,
        },
      }),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as BacktestResult;
  } catch {
    return null;
  }
}
