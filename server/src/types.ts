export type Exchange = "gate" | "okx";

export type Interval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

export interface Candle {
  exchange: Exchange;
  symbol: string;
  interval: Interval;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover: number | null;
}

export interface CandleInput {
  exchange: Exchange;
  symbol: string;
  interval: Interval;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover?: number | null;
}

export interface BacktestTrade {
  side: "long" | "short";
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  pnlPct: number;
  reason: string;
  marketBreadthBias?: "bull" | "bear" | "neutral";
  filteredByMarketBreadth?: boolean;
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
