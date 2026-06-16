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
  adxPeriod: number;
  minAdx: number;
  atrPeriod: number;
  atrStopMultiplier: number;
  atrTrailMultiplier: number;
  useTrailingStop: boolean;
  feeRate: number;
  slippageRate: number;
  cooldownBars: number;
  maxHoldBars: number;
}

export interface BacktestSectionResult {
  metrics: BacktestMetrics;
  trades: BacktestTrade[];
  exitReasons: Record<string, number>;
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
  adxPeriod: 14,
  minAdx: 15,
  atrPeriod: 14,
  atrStopMultiplier: 1.8,
  atrTrailMultiplier: 3.5,
  useTrailingStop: true,
  feeRate: 0.0005,
  slippageRate: 0.0002,
  cooldownBars: 1,
  maxHoldBars: 0,
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

function trueRange(candles: Candle[], index: number) {
  const current = candles[index];
  const prev = candles[index - 1];
  return Math.max(current.high - current.low, Math.abs(current.high - prev.close), Math.abs(current.low - prev.close));
}

function atrAt(candles: Candle[], index: number, period: number) {
  if (index < period) return null;
  let sum = 0;
  for (let i = index - period + 1; i <= index; i += 1) sum += trueRange(candles, i);
  return sum / period;
}

function adxAt(candles: Candle[], index: number, period: number) {
  if (index < period * 2) return null;
  const dxValues: number[] = [];
  for (let end = index - period + 1; end <= index; end += 1) {
    let trSum = 0;
    let plusDmSum = 0;
    let minusDmSum = 0;
    for (let i = end - period + 1; i <= end; i += 1) {
      const current = candles[i];
      const prev = candles[i - 1];
      const upMove = current.high - prev.high;
      const downMove = prev.low - current.low;
      trSum += trueRange(candles, i);
      plusDmSum += upMove > downMove && upMove > 0 ? upMove : 0;
      minusDmSum += downMove > upMove && downMove > 0 ? downMove : 0;
    }
    if (trSum === 0) {
      dxValues.push(0);
      continue;
    }
    const plusDi = (plusDmSum / trSum) * 100;
    const minusDi = (minusDmSum / trSum) * 100;
    const diSum = plusDi + minusDi;
    dxValues.push(diSum === 0 ? 0 : (Math.abs(plusDi - minusDi) / diSum) * 100);
  }
  return dxValues.reduce((sum, value) => sum + value, 0) / dxValues.length;
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

function tradingCost(params: BacktestParams) {
  return params.feeRate * 2 + params.slippageRate * 2;
}

function applyEntrySlippage(price: number, side: "long" | "short", slippageRate: number) {
  return side === "long" ? price * (1 + slippageRate) : price * (1 - slippageRate);
}

function applyExitSlippage(price: number, side: "long" | "short", slippageRate: number) {
  return side === "long" ? price * (1 - slippageRate) : price * (1 + slippageRate);
}

function getEntrySignal(candles: Candle[], index: number, params: BacktestParams): "long" | "short" | null {
  const prevFast = smaAt(candles, index - 1, params.fastPeriod);
  const prevSlow = smaAt(candles, index - 1, params.slowPeriod);
  const fast = smaAt(candles, index, params.fastPeriod);
  const slow = smaAt(candles, index, params.slowPeriod);
  if (prevFast === null || prevSlow === null || fast === null || slow === null) return null;

  if (params.strategy === "sma_rsi_pullback") {
    const rsiValue = rsiAt(candles, index, params.rsiPeriod);
    const adxValue = adxAt(candles, index, params.adxPeriod);
    if (rsiValue === null || adxValue === null || adxValue < params.minAdx) return null;
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
  const exitReasons: Record<string, number> = {};
  let position: { side: "long" | "short"; entryTime: number; entryPrice: number; entryIndex: number; stopPrice: number | null } | null = null;
  let cooldownUntil = -1;

  const warmup = Math.max(params.slowPeriod + 1, params.rsiPeriod + 1, params.atrPeriod + 1, params.adxPeriod * 2 + 1);
  for (let i = warmup; i < candles.length; i += 1) {
    const candle = candles[i];
    if (position) {
      const direction = position.side === "long" ? 1 : -1;
      const atrValue = atrAt(candles, i, params.atrPeriod);
      if (params.useTrailingStop && atrValue !== null) {
        const candidateStop = candle.close - direction * atrValue * params.atrTrailMultiplier;
        position.stopPrice = position.stopPrice === null
          ? candidateStop
          : position.side === "long"
            ? Math.max(position.stopPrice, candidateStop)
            : Math.min(position.stopPrice, candidateStop);
      }

      const exitPriceWithSlippage = applyExitSlippage(candle.close, position.side, params.slippageRate);
      const rawPnlPct = ((exitPriceWithSlippage - position.entryPrice) / position.entryPrice) * direction;
      const pnlPct = rawPnlPct - tradingCost(params);
      const crossedFixedStop = rawPnlPct <= -params.stopLossPct;
      const crossedTakeProfit = rawPnlPct >= params.takeProfitPct;
      const crossedTrailingStop = params.useTrailingStop && position.stopPrice !== null && (position.side === "long" ? candle.close <= position.stopPrice : candle.close >= position.stopPrice);
      const reversed = shouldReverseExit(candles, i, position.side, params);
      const timedOut = params.maxHoldBars > 0 && i - position.entryIndex >= params.maxHoldBars;

      if (crossedFixedStop || crossedTakeProfit || crossedTrailingStop || reversed || timedOut) {
        const reason = crossedFixedStop ? "stop_loss" : crossedTakeProfit ? "take_profit" : crossedTrailingStop ? "trailing_stop" : reversed ? "reverse" : "time_exit";
        exitReasons[reason] = (exitReasons[reason] ?? 0) + 1;
        trades.push({
          side: position.side,
          entryTime: position.entryTime,
          exitTime: candle.time,
          entryPrice: position.entryPrice,
          exitPrice: exitPriceWithSlippage,
          pnlPct,
          reason,
        });
        position = null;
        cooldownUntil = i + Math.max(0, params.cooldownBars);
      }
    }

    if (!position && i >= cooldownUntil) {
      const signal = getEntrySignal(candles, i, params);
      if (signal) {
        const atrValue = atrAt(candles, i, params.atrPeriod);
        const entryPrice = applyEntrySlippage(candle.close, signal, params.slippageRate);
        const direction = signal === "long" ? 1 : -1;
        const atrStopDistance = atrValue === null ? entryPrice * params.stopLossPct : atrValue * params.atrStopMultiplier;
        position = {
          side: signal,
          entryTime: candle.time,
          entryPrice,
          entryIndex: i,
          stopPrice: params.useTrailingStop ? entryPrice - direction * atrStopDistance : null,
        };
      }
    }
  }

  return { metrics: metrics(candles, trades), trades, exitReasons };
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
