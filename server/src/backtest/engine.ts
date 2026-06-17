import type { BacktestMetrics, BacktestTrade, Candle } from "../types";

export type BacktestStrategyName = "dual_ma" | "sma_rsi_pullback";
export type TradeDirection = "both" | "long_only" | "short_only";
export type HigherTimeframe = "4h" | "1d";
export type BreadthNeutralMode = "block_all" | "allow_current_filter";

export interface BacktestParams {
  strategy: BacktestStrategyName;
  fastPeriod: number;
  slowPeriod: number;
  entryThreshold: number;
  stopLossPct: number;
  takeProfitPct: number;
  takeProfitAtrMultiplier: number;
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
  tradeDirection: TradeDirection;
  useHigherTimeframeFilter: boolean;
  higherTimeframe: HigherTimeframe;
  higherTimeframeSmaPeriod: number;
  requireHigherTimeframeSlope: boolean;
  signalDelayBars: number;
  conservativeSameBarExit: boolean;
  minSlowSmaDistancePct: number;
  minAtrPct: number;
  stopLossCircuitLookbackTrades: number;
  stopLossCircuitMinStops: number;
  stopLossCircuitCooldownBars: number;
  useMarketBreadthFilter: boolean;
  breadthTimeframe: HigherTimeframe;
  breadthSmaPeriod: number;
  breadthBullThreshold: number;
  breadthBearThreshold: number;
  breadthNeutralMode: BreadthNeutralMode;
}

export interface DirectionBreakdown {
  long: BacktestMetrics;
  short: BacktestMetrics;
}

export interface MarketBreadthSymbolDiagnostics {
  symbol: string;
  rawCandles: number;
  bucketCandles: number;
  usableBuckets: number;
}

export interface MarketBreadthDiagnostics {
  requestedSymbols: string[];
  eligibleSymbols: string[];
  minRequiredSymbols: number;
  bucketCount: number;
  usableBucketCount: number;
  stateCounts: Record<"bull" | "bear" | "neutral", number>;
  averageValidSymbols: number;
  minValidSymbols: number;
  maxValidSymbols: number;
  averageBullRatio: number;
  averageBearRatio: number;
  coverageRatio: number;
  symbolStats: MarketBreadthSymbolDiagnostics[];
  status: "disabled" | "insufficient_symbols" | "ok";
}

export interface BacktestSectionResult {
  metrics: BacktestMetrics;
  trades: BacktestTrade[];
  candidateTrades?: BacktestTrade[];
  marketBreadthDiagnostics?: MarketBreadthDiagnostics;
  exitReasons: Record<string, number>;
  directionBreakdown: DirectionBreakdown;
}

export interface WalkForwardRow {
  label: string;
  trainRatio: number;
  testStartIndex: number;
  testEndIndex: number;
  result: BacktestSectionResult;
  passed: boolean;
}

export interface BacktestResult {
  symbol: string;
  interval: string;
  strategy: BacktestStrategyName;
  split: {
    train: BacktestSectionResult;
    test: BacktestSectionResult;
  };
  walkForward: WalkForwardRow[];
}

const DEFAULT_PARAMS: BacktestParams = {
  strategy: "dual_ma",
  fastPeriod: 20,
  slowPeriod: 60,
  entryThreshold: 0,
  stopLossPct: 0.012,
  takeProfitPct: 0.024,
  takeProfitAtrMultiplier: 0,
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
  tradeDirection: "both",
  useHigherTimeframeFilter: false,
  higherTimeframe: "4h",
  higherTimeframeSmaPeriod: 50,
  requireHigherTimeframeSlope: true,
  signalDelayBars: 0,
  conservativeSameBarExit: false,
  minSlowSmaDistancePct: 0,
  minAtrPct: 0,
  stopLossCircuitLookbackTrades: 0,
  stopLossCircuitMinStops: 0,
  stopLossCircuitCooldownBars: 0,
  useMarketBreadthFilter: false,
  breadthTimeframe: "4h",
  breadthSmaPeriod: 30,
  breadthBullThreshold: 0.55,
  breadthBearThreshold: 0.55,
  breadthNeutralMode: "allow_current_filter",
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

function simulateTradeExit(candles: Candle[], entryIndex: number, side: "long" | "short", params: BacktestParams, marketBreadthBias: MarketBreadthBias, filteredByMarketBreadth: boolean): BacktestTrade | null {
  const entryCandle = candles[entryIndex];
  if (!entryCandle) return null;
  const entryPrice = applyEntrySlippage(entryCandle.close, side, params.slippageRate);
  const direction = side === "long" ? 1 : -1;
  const atrValueAtEntry = atrAt(candles, entryIndex, params.atrPeriod);
  const atrStopDistance = atrValueAtEntry === null ? entryPrice * params.stopLossPct : atrValueAtEntry * params.atrStopMultiplier;
  let stopPrice: number | null = params.useTrailingStop ? entryPrice - direction * atrStopDistance : null;
  for (let i = entryIndex + 1; i < candles.length; i += 1) {
    const candle = candles[i];
    const atrValue = atrAt(candles, i, params.atrPeriod);
    if (params.useTrailingStop && atrValue !== null) {
      const candidateStop = candle.close - direction * atrValue * params.atrTrailMultiplier;
      stopPrice = stopPrice === null ? candidateStop : side === "long" ? Math.max(stopPrice, candidateStop) : Math.min(stopPrice, candidateStop);
    }
    const closeExitPriceWithSlippage = applyExitSlippage(candle.close, side, params.slippageRate);
    const closeRawPnlPct = ((closeExitPriceWithSlippage - entryPrice) / entryPrice) * direction;
    const atrTakeProfitPct = atrValue === null || params.takeProfitAtrMultiplier <= 0 ? null : (atrValue * params.takeProfitAtrMultiplier) / entryPrice;
    const takeProfitPct = atrTakeProfitPct ?? params.takeProfitPct;
    const fixedStopPrice = entryPrice * (side === "long" ? 1 - params.stopLossPct : 1 + params.stopLossPct);
    const takeProfitPrice = entryPrice * (side === "long" ? 1 + takeProfitPct : 1 - takeProfitPct);
    const touchedFixedStop = side === "long" ? candle.low <= fixedStopPrice : candle.high >= fixedStopPrice;
    const touchedTakeProfit = side === "long" ? candle.high >= takeProfitPrice : candle.low <= takeProfitPrice;
    const touchedTrailingStop = params.useTrailingStop && stopPrice !== null && (side === "long" ? candle.low <= stopPrice : candle.high >= stopPrice);
    const crossedFixedStop = params.conservativeSameBarExit ? touchedFixedStop : closeRawPnlPct <= -params.stopLossPct;
    const crossedTakeProfit = params.conservativeSameBarExit ? touchedTakeProfit : closeRawPnlPct >= takeProfitPct;
    const crossedTrailingStop = params.conservativeSameBarExit ? touchedTrailingStop : params.useTrailingStop && stopPrice !== null && (side === "long" ? candle.close <= stopPrice : candle.close >= stopPrice);
    const reversed = shouldReverseExit(candles, i, side, params);
    const timedOut = params.maxHoldBars > 0 && i - entryIndex >= params.maxHoldBars;
    if (crossedFixedStop || crossedTakeProfit || crossedTrailingStop || reversed || timedOut) {
      const stopConflictsWithTakeProfit = params.conservativeSameBarExit && crossedTakeProfit && (crossedFixedStop || crossedTrailingStop);
      const reason = stopConflictsWithTakeProfit ? crossedFixedStop ? "stop_loss" : "trailing_stop" : crossedFixedStop ? "stop_loss" : crossedTakeProfit ? "take_profit" : crossedTrailingStop ? "trailing_stop" : reversed ? "reverse" : "time_exit";
      const rawExitPrice = reason === "stop_loss" ? fixedStopPrice : reason === "take_profit" ? takeProfitPrice : reason === "trailing_stop" && stopPrice !== null ? stopPrice : candle.close;
      const exitPrice = applyExitSlippage(rawExitPrice, side, params.slippageRate);
      const rawPnlPct = ((exitPrice - entryPrice) / entryPrice) * direction;
      return { side, entryTime: entryCandle.time, exitTime: candle.time, entryPrice, exitPrice, pnlPct: rawPnlPct - tradingCost(params), reason, marketBreadthBias, filteredByMarketBreadth };
    }
  }
  return null;
}

function isDirectionAllowed(signal: "long" | "short", tradeDirection: TradeDirection) {
  return tradeDirection === "both" || (tradeDirection === "long_only" && signal === "long") || (tradeDirection === "short_only" && signal === "short");
}

function higherTimeframeSeconds(timeframe: HigherTimeframe) {
  return timeframe === "1d" ? 24 * 60 * 60 : 4 * 60 * 60;
}

type HigherTimeframeBias = "bull" | "bear" | "neutral";
type MarketBreadthBias = HigherTimeframeBias;

type HigherTimeframeBucket = Candle & { firstIndex: number; lastIndex: number };

function buildHigherTimeframeBias(candles: Candle[], params: BacktestParams): HigherTimeframeBias[] {
  const biases: HigherTimeframeBias[] = Array.from({ length: candles.length }, () => "neutral");
  if (!params.useHigherTimeframeFilter) return biases;

  const seconds = higherTimeframeSeconds(params.higherTimeframe);
  const buckets: HigherTimeframeBucket[] = [];
  const bucketIndexByTime = new Map<number, number>();
  candles.forEach((candle, index) => {
    const bucketTime = Math.floor(candle.time / seconds) * seconds;
    const bucketIndex = bucketIndexByTime.get(bucketTime);
    if (bucketIndex === undefined) {
      bucketIndexByTime.set(bucketTime, buckets.length);
      buckets.push({ ...candle, time: bucketTime, firstIndex: index, lastIndex: index });
      return;
    }
    const existing = buckets[bucketIndex];
    existing.high = Math.max(existing.high, candle.high);
    existing.low = Math.min(existing.low, candle.low);
    existing.close = candle.close;
    existing.volume += candle.volume;
    existing.turnover = (existing.turnover ?? 0) + (candle.turnover ?? 0);
    existing.lastIndex = index;
  });

  const higherCandles: Candle[] = buckets.map((bucket) => ({
    time: bucket.time,
    open: bucket.open,
    high: bucket.high,
    low: bucket.low,
    close: bucket.close,
    volume: bucket.volume,
    turnover: bucket.turnover,
  }));
  const period = Math.max(2, Math.floor(params.higherTimeframeSmaPeriod));
  const biasForCompletedBucket = (bucketIndex: number): HigherTimeframeBias => {
    const currentSma = smaAt(higherCandles, bucketIndex, period);
    const prevSma = smaAt(higherCandles, bucketIndex - 1, period);
    if (currentSma === null || prevSma === null) return "neutral";
    const close = higherCandles[bucketIndex].close;
    const slopeUp = currentSma > prevSma;
    const slopeDown = currentSma < prevSma;
    if (close > currentSma && (!params.requireHigherTimeframeSlope || slopeUp)) return "bull";
    if (close < currentSma && (!params.requireHigherTimeframeSlope || slopeDown)) return "bear";
    return "neutral";
  };

  for (let bucketIndex = 1; bucketIndex < buckets.length; bucketIndex += 1) {
    const bias = biasForCompletedBucket(bucketIndex - 1);
    for (let candleIndex = buckets[bucketIndex].firstIndex; candleIndex <= buckets[bucketIndex].lastIndex; candleIndex += 1) {
      biases[candleIndex] = bias;
    }
  }
  return biases;
}

function buildMarketBreadthBias(candles: Candle[], params: BacktestParams, breadthCandlesBySymbol?: Record<string, Candle[]>): { biases: MarketBreadthBias[]; diagnostics?: MarketBreadthDiagnostics } {
  const biases: MarketBreadthBias[] = Array.from({ length: candles.length }, () => "neutral");
  const requestedSymbols = Object.keys(breadthCandlesBySymbol ?? {});
  const disabledDiagnostics = (status: MarketBreadthDiagnostics["status"]): MarketBreadthDiagnostics => ({
    requestedSymbols,
    eligibleSymbols: [],
    minRequiredSymbols: 3,
    bucketCount: 0,
    usableBucketCount: 0,
    stateCounts: { bull: 0, bear: 0, neutral: 0 },
    averageValidSymbols: 0,
    minValidSymbols: 0,
    maxValidSymbols: 0,
    averageBullRatio: 0,
    averageBearRatio: 0,
    coverageRatio: 0,
    symbolStats: requestedSymbols.map((symbol) => ({ symbol, rawCandles: breadthCandlesBySymbol?.[symbol]?.length ?? 0, bucketCandles: 0, usableBuckets: 0 })),
    status,
  });
  if (!params.useMarketBreadthFilter || !breadthCandlesBySymbol) return { biases, diagnostics: disabledDiagnostics("disabled") };

  const symbols = requestedSymbols.filter((symbol) => breadthCandlesBySymbol[symbol].length >= Math.max(params.breadthSmaPeriod + 2, 30));
  if (symbols.length < 3) return { biases, diagnostics: { ...disabledDiagnostics("insufficient_symbols"), eligibleSymbols: symbols } };

  const seconds = higherTimeframeSeconds(params.breadthTimeframe);
  const period = Math.max(2, Math.floor(params.breadthSmaPeriod));
  const stateByBucketTime = new Map<number, MarketBreadthBias>();
  const allBucketTimes = new Set<number>();
  const bucketCandlesBySymbol = new Map<string, Candle[]>();
  const symbolStats = new Map<string, MarketBreadthSymbolDiagnostics>();

  for (const symbol of symbols) {
    const sourceCandles = breadthCandlesBySymbol[symbol];
    const bucketMap = new Map<number, Candle>();
    for (const candle of sourceCandles) {
      const bucketTime = Math.floor(candle.time / seconds) * seconds;
      const existing = bucketMap.get(bucketTime);
      if (!existing) {
        bucketMap.set(bucketTime, { ...candle, time: bucketTime });
        allBucketTimes.add(bucketTime);
        continue;
      }
      existing.high = Math.max(existing.high, candle.high);
      existing.low = Math.min(existing.low, candle.low);
      existing.close = candle.close;
      existing.volume += candle.volume;
      existing.turnover = (existing.turnover ?? 0) + (candle.turnover ?? 0);
    }
    const series = [...bucketMap.values()].sort((a, b) => a.time - b.time);
    bucketCandlesBySymbol.set(symbol, series);
    symbolStats.set(symbol, { symbol, rawCandles: sourceCandles.length, bucketCandles: series.length, usableBuckets: 0 });
  }

  const validCounts: number[] = [];
  const bullRatios: number[] = [];
  const bearRatios: number[] = [];
  const stateCounts: Record<MarketBreadthBias, number> = { bull: 0, bear: 0, neutral: 0 };
  const sortedBucketTimes = [...allBucketTimes].sort((a, b) => a - b);
  for (const bucketTime of sortedBucketTimes) {
    let validCount = 0;
    let bullCount = 0;
    let bearCount = 0;
    for (const symbol of symbols) {
      const series = bucketCandlesBySymbol.get(symbol) ?? [];
      const bucketIndex = series.findIndex((candle) => candle.time === bucketTime);
      if (bucketIndex < 0) continue;
      const currentSma = smaAt(series, bucketIndex, period);
      const prevSma = smaAt(series, bucketIndex - 1, period);
      if (currentSma === null || prevSma === null) continue;
      validCount += 1;
      const stat = symbolStats.get(symbol);
      if (stat) stat.usableBuckets += 1;
      const close = series[bucketIndex].close;
      if (close > currentSma && currentSma > prevSma) bullCount += 1;
      if (close < currentSma && currentSma < prevSma) bearCount += 1;
    }
    if (validCount < 3) {
      stateByBucketTime.set(bucketTime, "neutral");
      continue;
    }
    const bullRatio = bullCount / validCount;
    const bearRatio = bearCount / validCount;
    const state = bullRatio >= params.breadthBullThreshold && bullRatio > bearRatio
      ? "bull"
      : bearRatio >= params.breadthBearThreshold && bearRatio > bullRatio
        ? "bear"
        : "neutral";
    stateByBucketTime.set(bucketTime, state);
    stateCounts[state] += 1;
    validCounts.push(validCount);
    bullRatios.push(bullRatio);
    bearRatios.push(bearRatio);
  }

  let activeBias: MarketBreadthBias = "neutral";
  let activeBucketTime: number | null = null;
  for (let i = 0; i < candles.length; i += 1) {
    const bucketTime = Math.floor(candles[i].time / seconds) * seconds;
    if (activeBucketTime === null || bucketTime > activeBucketTime) {
      const completedBucketTime = bucketTime - seconds;
      activeBias = stateByBucketTime.get(completedBucketTime) ?? "neutral";
      activeBucketTime = bucketTime;
    }
    biases[i] = activeBias;
  }

  const usableBucketCount = validCounts.length;
  const diagnostics: MarketBreadthDiagnostics = {
    requestedSymbols,
    eligibleSymbols: symbols,
    minRequiredSymbols: 3,
    bucketCount: sortedBucketTimes.length,
    usableBucketCount,
    stateCounts,
    averageValidSymbols: validCounts.length ? validCounts.reduce((sum, value) => sum + value, 0) / validCounts.length : 0,
    minValidSymbols: validCounts.length ? Math.min(...validCounts) : 0,
    maxValidSymbols: validCounts.length ? Math.max(...validCounts) : 0,
    averageBullRatio: bullRatios.length ? bullRatios.reduce((sum, value) => sum + value, 0) / bullRatios.length : 0,
    averageBearRatio: bearRatios.length ? bearRatios.reduce((sum, value) => sum + value, 0) / bearRatios.length : 0,
    coverageRatio: sortedBucketTimes.length ? usableBucketCount / sortedBucketTimes.length : 0,
    symbolStats: requestedSymbols.map((symbol) => symbolStats.get(symbol) ?? { symbol, rawCandles: breadthCandlesBySymbol[symbol]?.length ?? 0, bucketCandles: 0, usableBuckets: 0 }),
    status: "ok",
  };
  return { biases, diagnostics };
}

function isAllowedByHigherTimeframe(signal: "long" | "short", bias: HigherTimeframeBias, params: BacktestParams) {
  if (!params.useHigherTimeframeFilter) return true;
  if (bias === "bull") return signal === "long";
  if (bias === "bear") return signal === "short";
  return false;
}

function isAllowedByMarketBreadth(signal: "long" | "short", bias: MarketBreadthBias, params: BacktestParams) {
  if (!params.useMarketBreadthFilter) return true;
  if (bias === "bull") return signal === "long";
  if (bias === "bear") return signal === "short";
  return params.breadthNeutralMode === "allow_current_filter";
}

function isAllowedByTrendQuality(candles: Candle[], index: number, params: BacktestParams) {
  const slow = smaAt(candles, index, params.slowPeriod);
  const atrValue = atrAt(candles, index, params.atrPeriod);
  if (params.minSlowSmaDistancePct > 0) {
    if (slow === null) return false;
    const distance = Math.abs((candles[index].close - slow) / candles[index].close);
    if (distance < params.minSlowSmaDistancePct) return false;
  }
  if (params.minAtrPct > 0) {
    if (atrValue === null) return false;
    if (atrValue / candles[index].close < params.minAtrPct) return false;
  }
  return true;
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

function directionBreakdown(candles: Candle[], trades: BacktestTrade[]): DirectionBreakdown {
  return {
    long: metrics(candles, trades.filter((trade) => trade.side === "long")),
    short: metrics(candles, trades.filter((trade) => trade.side === "short")),
  };
}

export function runSectionBacktest(candles: Candle[], inputParams?: Partial<BacktestParams>, breadthCandlesBySymbol?: Record<string, Candle[]>): BacktestSectionResult {
  const params = { ...DEFAULT_PARAMS, ...inputParams };
  const trades: BacktestTrade[] = [];
  const candidateTrades: BacktestTrade[] = [];
  const exitReasons: Record<string, number> = {};
  let position: { side: "long" | "short"; entryTime: number; entryPrice: number; entryIndex: number; stopPrice: number | null; marketBreadthBias: MarketBreadthBias; filteredByMarketBreadth: boolean } | null = null;
  let cooldownUntil = -1;
  let pendingEntry: { signal: "long" | "short"; executeIndex: number; marketBreadthBias: MarketBreadthBias; filteredByMarketBreadth: boolean } | null = null;
  const higherTimeframeBiases = buildHigherTimeframeBias(candles, params);
  const marketBreadth = buildMarketBreadthBias(candles, params, breadthCandlesBySymbol);
  const marketBreadthBiases = marketBreadth.biases;

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

      const closeExitPriceWithSlippage = applyExitSlippage(candle.close, position.side, params.slippageRate);
      const closeRawPnlPct = ((closeExitPriceWithSlippage - position.entryPrice) / position.entryPrice) * direction;
      const atrTakeProfitPct = atrValue === null || params.takeProfitAtrMultiplier <= 0 ? null : (atrValue * params.takeProfitAtrMultiplier) / position.entryPrice;
      const takeProfitPct = atrTakeProfitPct ?? params.takeProfitPct;
      const fixedStopPrice = position.entryPrice * (position.side === "long" ? 1 - params.stopLossPct : 1 + params.stopLossPct);
      const takeProfitPrice = position.entryPrice * (position.side === "long" ? 1 + takeProfitPct : 1 - takeProfitPct);
      const touchedFixedStop = position.side === "long" ? candle.low <= fixedStopPrice : candle.high >= fixedStopPrice;
      const touchedTakeProfit = position.side === "long" ? candle.high >= takeProfitPrice : candle.low <= takeProfitPrice;
      const touchedTrailingStop = params.useTrailingStop && position.stopPrice !== null && (position.side === "long" ? candle.low <= position.stopPrice : candle.high >= position.stopPrice);
      const crossedFixedStop = params.conservativeSameBarExit ? touchedFixedStop : closeRawPnlPct <= -params.stopLossPct;
      const crossedTakeProfit = params.conservativeSameBarExit ? touchedTakeProfit : closeRawPnlPct >= takeProfitPct;
      const crossedTrailingStop = params.conservativeSameBarExit ? touchedTrailingStop : params.useTrailingStop && position.stopPrice !== null && (position.side === "long" ? candle.close <= position.stopPrice : candle.close >= position.stopPrice);
      const reversed = shouldReverseExit(candles, i, position.side, params);
      const timedOut = params.maxHoldBars > 0 && i - position.entryIndex >= params.maxHoldBars;

      if (crossedFixedStop || crossedTakeProfit || crossedTrailingStop || reversed || timedOut) {
        const stopConflictsWithTakeProfit = params.conservativeSameBarExit && crossedTakeProfit && (crossedFixedStop || crossedTrailingStop);
        const reason = stopConflictsWithTakeProfit
          ? crossedFixedStop
            ? "stop_loss"
            : "trailing_stop"
          : crossedFixedStop
            ? "stop_loss"
            : crossedTakeProfit
              ? "take_profit"
              : crossedTrailingStop
                ? "trailing_stop"
                : reversed
                  ? "reverse"
                  : "time_exit";
        const rawExitPrice = reason === "stop_loss"
          ? fixedStopPrice
          : reason === "take_profit"
            ? takeProfitPrice
            : reason === "trailing_stop" && position.stopPrice !== null
              ? position.stopPrice
              : candle.close;
        const exitPriceWithSlippage = applyExitSlippage(rawExitPrice, position.side, params.slippageRate);
        const rawPnlPct = ((exitPriceWithSlippage - position.entryPrice) / position.entryPrice) * direction;
        const pnlPct = rawPnlPct - tradingCost(params);
        exitReasons[reason] = (exitReasons[reason] ?? 0) + 1;
        trades.push({
          side: position.side,
          entryTime: position.entryTime,
          exitTime: candle.time,
          entryPrice: position.entryPrice,
          exitPrice: exitPriceWithSlippage,
          pnlPct,
          reason,
          marketBreadthBias: position.marketBreadthBias,
          filteredByMarketBreadth: position.filteredByMarketBreadth,
        });
        position = null;
        cooldownUntil = i + Math.max(0, params.cooldownBars);
        const stopLossCircuitEnabled =
          params.stopLossCircuitLookbackTrades > 0 &&
          params.stopLossCircuitMinStops > 0 &&
          params.stopLossCircuitCooldownBars > 0;
        if (stopLossCircuitEnabled) {
          const lookbackTrades = Math.floor(params.stopLossCircuitLookbackTrades);
          const minStops = Math.floor(params.stopLossCircuitMinStops);
          const recentTrades = trades.slice(-lookbackTrades);
          const stopLossCount = recentTrades.filter((trade) => trade.reason === "stop_loss").length;
          if (recentTrades.length >= lookbackTrades && stopLossCount >= minStops) {
            cooldownUntil = Math.max(cooldownUntil, i + Math.floor(params.stopLossCircuitCooldownBars));
          }
        }
      }
    }

    if (!position && i >= cooldownUntil && pendingEntry && i >= pendingEntry.executeIndex) {
      const entry = pendingEntry;
      const signal = entry.signal;
      pendingEntry = null;
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
        marketBreadthBias: entry.marketBreadthBias,
        filteredByMarketBreadth: entry.filteredByMarketBreadth,
      };
    }

    if (!position && i >= cooldownUntil && !pendingEntry) {
      const signal = getEntrySignal(candles, i, params);
      if (signal && isDirectionAllowed(signal, params.tradeDirection) && isAllowedByHigherTimeframe(signal, higherTimeframeBiases[i], params) && isAllowedByTrendQuality(candles, i, params)) {
        const allowedByBreadth = isAllowedByMarketBreadth(signal, marketBreadthBiases[i], params);
        if (!allowedByBreadth && !params.useMarketBreadthFilter) continue;
        if (!allowedByBreadth && params.useMarketBreadthFilter) {
          const candidateResult = simulateTradeExit(candles, i, signal, params, marketBreadthBiases[i], true);
          if (candidateResult) candidateTrades.push(candidateResult);
          continue;
        }
        const delay = Math.max(0, Math.floor(params.signalDelayBars));
        if (delay > 0) {
          pendingEntry = { signal, executeIndex: i + delay, marketBreadthBias: marketBreadthBiases[i], filteredByMarketBreadth: false };
        } else {
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
            marketBreadthBias: marketBreadthBiases[i],
            filteredByMarketBreadth: false,
          };
        }
      }
    }
  }

  return { metrics: metrics(candles, trades), trades, candidateTrades, marketBreadthDiagnostics: marketBreadth.diagnostics, exitReasons, directionBreakdown: directionBreakdown(candles, trades) };
}

function runWalkForward(candles: Candle[], strategyParams: BacktestParams): WalkForwardRow[] {
  const windows = [
    { label: "50%→10%", trainRatio: 0.5 },
    { label: "60%→10%", trainRatio: 0.6 },
    { label: "70%→10%", trainRatio: 0.7 },
    { label: "80%→10%", trainRatio: 0.8 },
  ];
  const testSize = Math.max(120, Math.floor(candles.length * 0.1));

  return windows.map((window) => {
    const trainEnd = Math.floor(candles.length * window.trainRatio);
    const testStart = Math.max(0, trainEnd - 80);
    const testEnd = Math.min(candles.length, trainEnd + testSize);
    const result = runSectionBacktest(candles.slice(testStart, testEnd), strategyParams);
    const metrics = result.metrics;
    return {
      label: window.label,
      trainRatio: window.trainRatio,
      testStartIndex: testStart,
      testEndIndex: testEnd,
      result,
      passed: metrics.trades >= 5 && metrics.profitFactor > 1 && metrics.totalReturn > 0 && metrics.maxDrawdown >= -0.1,
    };
  });
}

export function runSplitBacktest(params: {
  symbol: string;
  interval: string;
  candles: Candle[];
  trainRatio?: number;
  strategyParams?: Partial<BacktestParams>;
  breadthCandlesBySymbol?: Record<string, Candle[]>;
}): BacktestResult {
  const trainRatio = Math.min(Math.max(params.trainRatio ?? 0.7, 0.2), 0.9);
  const splitIndex = Math.floor(params.candles.length * trainRatio);
  const trainStart = 0;
  const trainEnd = splitIndex;
  const testStart = Math.max(0, splitIndex - 80);
  const testEnd = params.candles.length;
  const trainCandles = params.candles.slice(trainStart, trainEnd);
  const testCandles = params.candles.slice(testStart, testEnd);

  const strategyParams = { ...DEFAULT_PARAMS, ...params.strategyParams };
  const sliceBreadthCandles = (startIndex: number, endIndex: number) => {
    if (!params.breadthCandlesBySymbol) return undefined;
    const startTime = params.candles[startIndex]?.time ?? params.candles[0]?.time ?? 0;
    const endTime = params.candles[Math.max(startIndex, endIndex - 1)]?.time ?? params.candles[params.candles.length - 1]?.time ?? Number.MAX_SAFE_INTEGER;
    const paddingSeconds = higherTimeframeSeconds(strategyParams.breadthTimeframe) * Math.max(strategyParams.breadthSmaPeriod + 2, 4);
    return Object.fromEntries(Object.entries(params.breadthCandlesBySymbol).map(([symbol, symbolCandles]) => [
      symbol,
      symbolCandles.filter((candle) => candle.time >= startTime - paddingSeconds && candle.time <= endTime),
    ]));
  };

  return {
    symbol: params.symbol,
    interval: params.interval,
    strategy: strategyParams.strategy,
    split: {
      train: runSectionBacktest(trainCandles, strategyParams, sliceBreadthCandles(trainStart, trainEnd)),
      test: runSectionBacktest(testCandles, strategyParams, sliceBreadthCandles(testStart, testEnd)),
    },
    walkForward: runWalkForward(params.candles, strategyParams),
  };
}
