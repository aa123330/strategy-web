import type { CandleRow } from "../services/gatePublicApi";
import { sma } from "./indicators";

export type SignalAction = "OPEN_LONG" | "OPEN_SHORT" | "CLOSE_LONG" | "CLOSE_SHORT" | "HOLD";

export interface StrategySignal {
  action: SignalAction;
  price: number;
  reason: string;
  timestamp: number;
  symbol: string;
  score?: number;
  confidence?: number;
  entry?: number;
  stopLoss?: number;
  takeProfit1?: number;
  takeProfit2?: number;
  riskReward?: number;
  atr?: number;
  reasons?: string[];
  risks?: string[];
}

export interface PositionInfo {
  side: "long" | "short";
}

export function generateDualMaSignal(
  candles: CandleRow[],
  fastPeriod: number,
  slowPeriod: number,
  position: PositionInfo | null
): StrategySignal {
  const required = slowPeriod + 1;
  if (candles.length < required) {
    const last = candles.at(-1);
    return {
      action: "HOLD",
      price: last?.close ?? 0,
      reason: `K线数量不足（需要${required}根）`,
      timestamp: last?.time ?? 0,
      symbol: "ETH_USDT",
    };
  }

  const closes = candles.map((c) => c.close);
  const prevCloses = closes.slice(0, -1);

  const fastNow = sma(closes, fastPeriod);
  const fastPrev = sma(prevCloses, fastPeriod);
  const slowNow = sma(closes, slowPeriod);
  const slowPrev = sma(prevCloses, slowPeriod);

  const last = candles.at(-1)!;

  if (fastPrev === null || slowPrev === null) {
    return { action: "HOLD", price: last.close, reason: "均线未形成", timestamp: last.time, symbol: "ETH_USDT" };
  }

  const goldenCross = fastPrev <= slowPrev && fastNow! > slowNow!;
  const deathCross = fastPrev >= slowPrev && fastNow! < slowNow!;

  if (!position) {
    if (goldenCross) return { action: "OPEN_LONG", price: last.close, reason: "双均线金叉", timestamp: last.time, symbol: "ETH_USDT" };
    if (deathCross) return { action: "OPEN_SHORT", price: last.close, reason: "双均线死叉", timestamp: last.time, symbol: "ETH_USDT" };
    return { action: "HOLD", price: last.close, reason: "无仓且无交叉信号", timestamp: last.time, symbol: "ETH_USDT" };
  }

  if (position.side === "long" && deathCross) {
    return { action: "CLOSE_LONG", price: last.close, reason: "双均线死叉平多", timestamp: last.time, symbol: "ETH_USDT" };
  }
  if (position.side === "short" && goldenCross) {
    return { action: "CLOSE_SHORT", price: last.close, reason: "双均线金叉平空", timestamp: last.time, symbol: "ETH_USDT" };
  }

  return { action: "HOLD", price: last.close, reason: "已有方向未触发反向信号", timestamp: last.time, symbol: "ETH_USDT" };
}