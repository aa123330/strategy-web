import type { BacktestMetrics, BacktestTrade, Candle } from "../types";

export type BacktestStrategyName = "dual_ma" | "sma_rsi_pullback";

export interface BacktestParams {
  strategy: BacktestStrategyName;
  fastPeriod: number;
  slowPeriod: number;
  entryThreshold: number;
  stopLossPct: number;
  takeProfitPct: number;
  rsiPeriod: number;
  longRsiMax: number;
  shortRsiMin: number;
}

export interface BacktestSectionResult {
  metrics: BacktestMetrics;
  trades: BacktestTrade[];
}

export interface BacktestResult {
  symbol: string;
  interval: string;
  strategy: BacktestStrategyName;
  split: {
    train: BacktestSectionResult;
    test: BacktestSectionResult;
  };
}

const DEFAULT_PARAMS: BacktestParams = {
  strategy: "dual_ma",
  fastPeriod: 20,
  slowPeriod: 60,
  entryThreshold: 0,
  stopLossPct: 0.012,
  takeProfitPct: 0.024,
  rsiPeriod: 14,
  longRsiMax: 42,
  shortRsiMin: 58,
};

function smaAt(candles: Candle[], index: number, period: number) {
  if (index + 1 < period) return null;
  let sum = 0;
  for (let i = index - period + 1; i <= index; i += 1) sum += candles[i].close;
  return sum / period;
}

function rsiAt(candles: Candle[], index: number, period: number) {
  if (index < period) return null;
  let gainSum = 0;
  let lossSum = 0;
  for (let i = index - period + 1; i <= index; i += 1) {
    const change = candles[i].close - candles[i - 1].close;
    if (change >= 0) gainSum += change;
    else lossSum += Math.abs(change);
  }
  const avgGain = gainSum / period;
  const avgLoss = lossSum / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function maxDrawdown(equity: number[]) {
  let peak = equity[0] ?? 1;
  let maxDd = 0;
  for (const value of equity) {
    peak = Math.max(peak, value);
    maxDd = Math.min(maxDd, value / peak - 1);
  }
  return maxDd;
}

function getEntrySignal(candles: Candle[], index: number, params: BacktestParams): "long" | "short" | null {
  const prevFast = smaAt(candles, index - 1, params.fastPeriod);
  const prevSlow = smaAt(candles, index - 1, params.slowPeriod);
  const fast = smaAt(candles, index, params.fastPeriod);
  const slow = smaAt(candles, index, params.slowPeriod);
  if (prevFast === null || prevSlow === null || fast === null || slow === null) return null;

  if (params.strategy === "sma_rsi_pullback") {
    const rsiValue = rsiAt(candles, index, params.rsiPeriod);
    if (rsiValue === null) return null;
    const candle = candles[index];
    const trendUp = fast > slow && candle.close > slow;
    const trendDown = fast < slow && candle.close < slow;
    if (trendUp && rsiValue <= params.longRsiMax) return "long";
    if (trendDown && rsiValue >= params.shortRsiMin) return "short";
    return null;
  }

  const goldenCross = prevFast <= prevSlow && fast > slow;
  const deathCross = prevFast >= prevSlow && fast < slow;
  if (goldenCross) return "long";
  if (deathCross) return "short";
  return null;
}

function shouldReverseExit(candles: Candle[], index: number, side: "long" | "short", params: BacktestParams) {
  const fast = smaAt(candles, index, params.fastPeriod);
  const slow = smaAt(candles, index, params.slowPeriod);
  if (fast === null || slow === null) return false;

  if (params.strategy === "sma_rsi_pullback") {
    const rsiValue = rsiAt(candles, index, params.rsiPeriod);
    if (rsiValue === null) return false;
    if (side === "long") return fast < slow || rsiValue >= 62;
    return fast > slow || rsiValue <= 38;
  }

  return side === "long" ? fast < slow : fast > slow;
}

function metrics(candles: Candle[], trades: BacktestTrade[]): BacktestMetrics {
  const wins = trades.filter((t) => t.pnlPct > 0);
  const losses = trades.filter((t) => t.pnlPct <= 0);
  const grossProfit = wins.reduce((sum, t) => sum + t.pnlPct, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnlPct, 0));
  const equity = [1];
  let consecutiveLosses = 0;
  let maxConsecutiveLosses = 0;

  for (const trade of trades) {
    equity.push(equity[equity.length - 1] * (1 + trade.pnlPct));
    if (trade.pnlPct <= 0) {
      consecutiveLosses += 1;
      maxConsecutiveLosses = Math.max(maxConsecutiveLosses, consecutiveLosses);
    } else {
      consecutiveLosses = 0;
    }
  }

  return {
    candles: candles.length,
    trades: trades.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    totalReturn: equity[equity.length - 1] - 1,
    averageReturn: trades.length ? trades.reduce((sum, t) => sum + t.pnlPct, 0) / trades.length : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0,
    maxDrawdown: maxDrawdown(equity),
    maxConsecutiveLosses,
  };
}

export function runSectionBacktest(candles: Candle[], inputParams?: Partial<BacktestParams>): BacktestSectionResult {
  const params = { ...DEFAULT_PARAMS, ...inputParams };
  const trades: BacktestTrade[] = [];
  let position: { side: "long" | "short"; entryTime: number; entryPrice: number } | null = null;

  const warmup = Math.max(params.slowPeriod + 1, params.rsiPeriod + 1);
  for (let i = warmup; i < candles.length; i += 1) {
    const candle = candles[i];
    if (position) {
      const direction = position.side === "long" ? 1 : -1;
      const pnlPct = ((candle.close - position.entryPrice) / position.entryPrice) * direction;
      const crossedStop = pnlPct <= -params.stopLossPct;
      const crossedTakeProfit = pnlPct >= params.takeProfitPct;
      const reversed = shouldReverseExit(candles, i, position.side, params);

      if (crossedStop || crossedTakeProfit || reversed) {
        trades.push({
          side: position.side,
          entryTime: position.entryTime,
          exitTime: candle.time,
          entryPrice: position.entryPrice,
          exitPrice: candle.close,
          pnlPct,
          reason: crossedStop ? "stop_loss" : crossedTakeProfit ? "take_profit" : "reverse",
        });
        position = null;
      }
    }

    if (!position) {
      const signal = getEntrySignal(candles, i, params);
      if (signal) position = { side: signal, entryTime: candle.time, entryPrice: candle.close };
    }
  }

  return { metrics: metrics(candles, trades), trades };
}

export function runSplitBacktest(params: {
  symbol: string;
  interval: string;
  candles: Candle[];
  trainRatio?: number;
  strategyParams?: Partial<BacktestParams>;
}): BacktestResult {
  const trainRatio = Math.min(Math.max(params.trainRatio ?? 0.7, 0.2), 0.9);
  const splitIndex = Math.floor(params.candles.length * trainRatio);
  const trainCandles = params.candles.slice(0, splitIndex);
  const testCandles = params.candles.slice(Math.max(0, splitIndex - 80));

  const strategyParams = { ...DEFAULT_PARAMS, ...params.strategyParams };

  return {
    symbol: params.symbol,
    interval: params.interval,
    strategy: strategyParams.strategy,
    split: {
      train: runSectionBacktest(trainCandles, strategyParams),
      test: runSectionBacktest(testCandles, strategyParams),
    },
  };
}
