import type { CandleRow } from "../services/gatePublicApi";
import { atr, rsi, sma } from "./indicators";
import type { PositionInfo, StrategySignal } from "./dualMa";

export interface SmaRsiPullbackOptions {
  fastPeriod: number;
  slowPeriod: number;
  rsiPeriod?: number;
  longRsiMax?: number;
  shortRsiMin?: number;
  atrPeriod?: number;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function buildRiskPlan(action: StrategySignal["action"], entry: number, atrValue: number | null) {
  if (action !== "OPEN_LONG" && action !== "OPEN_SHORT") return {};
  const riskDistance = Math.max((atrValue ?? 0) * 1.4, entry * 0.005);
  const direction = action === "OPEN_LONG" ? 1 : -1;
  return {
    entry,
    stopLoss: entry - direction * riskDistance,
    takeProfit1: entry + direction * riskDistance * 1.8,
    takeProfit2: entry + direction * riskDistance * 2.8,
    riskReward: 1.8,
    atr: atrValue ?? undefined,
  };
}

export function generateSmaRsiPullbackSignal(
  candles: CandleRow[],
  options: SmaRsiPullbackOptions,
  position: PositionInfo | null
): StrategySignal {
  const last = candles.at(-1);
  if (!last) {
    return { action: "HOLD", price: 0, reason: "无K线数据", timestamp: 0, symbol: "ETH_USDT", score: 0, confidence: 0 };
  }

  const rsiPeriod = options.rsiPeriod ?? 14;
  const longRsiMax = options.longRsiMax ?? 42;
  const shortRsiMin = options.shortRsiMin ?? 58;
  const atrPeriod = options.atrPeriod ?? 14;
  const required = Math.max(options.slowPeriod + 2, rsiPeriod + 2, atrPeriod + 2);

  if (candles.length < required) {
    return {
      action: "HOLD",
      price: last.close,
      reason: `SMA+RSI策略数据不足，需要至少${required}根K线`,
      timestamp: last.time,
      symbol: "ETH_USDT",
      score: 0,
      confidence: 0,
      reasons: [`当前仅有${candles.length}根K线`],
      risks: ["样本不足时不生成开仓建议"],
    };
  }

  const closes = candles.map((c) => c.close);
  const prevCloses = closes.slice(0, -1);
  const fastNow = sma(closes, options.fastPeriod);
  const slowNow = sma(closes, options.slowPeriod);
  const fastPrev = sma(prevCloses, options.fastPeriod);
  const slowPrev = sma(prevCloses, options.slowPeriod);
  const rsiNow = rsi(closes, rsiPeriod);
  const rsiPrev = rsi(prevCloses, rsiPeriod);
  const atrValue = atr(candles, atrPeriod);

  if (!fastNow || !slowNow || !fastPrev || !slowPrev || rsiNow === null || rsiPrev === null) {
    return { action: "HOLD", price: last.close, reason: "SMA或RSI指标尚未形成", timestamp: last.time, symbol: "ETH_USDT", score: 0, confidence: 0 };
  }

  const trendUp = fastNow > slowNow && last.close > slowNow;
  const trendDown = fastNow < slowNow && last.close < slowNow;
  const rsiLongPullback = rsiNow <= longRsiMax && rsiNow >= rsiPrev - 8;
  const rsiShortBounce = rsiNow >= shortRsiMin && rsiNow <= rsiPrev + 8;
  const fastSlopeUp = fastNow >= fastPrev;
  const fastSlopeDown = fastNow <= fastPrev;
  const atrPct = atrValue ? atrValue / last.close : 0;
  const volatilityOk = atrPct >= 0.0015 && atrPct <= 0.03;

  let score = 0;
  const reasons: string[] = [];
  const risks: string[] = [];

  if (trendUp) {
    score += 35;
    reasons.push(`快线高于慢线，价格位于慢线之上，趋势偏多（SMA${options.fastPeriod}/${options.slowPeriod}）`);
  }
  if (trendDown) {
    score -= 35;
    reasons.push(`快线低于慢线，价格位于慢线之下，趋势偏空（SMA${options.fastPeriod}/${options.slowPeriod}）`);
  }
  if (rsiLongPullback) {
    score += 30;
    reasons.push(`RSI=${rsiNow.toFixed(1)}，处于多头趋势回调区间`);
  }
  if (rsiShortBounce) {
    score -= 30;
    reasons.push(`RSI=${rsiNow.toFixed(1)}，处于空头趋势反弹区间`);
  }
  if (fastSlopeUp) score += trendUp ? 10 : 0;
  if (fastSlopeDown) score -= trendDown ? 10 : 0;
  if (volatilityOk) {
    score += score > 0 ? 8 : score < 0 ? -8 : 0;
    reasons.push("ATR波动处于可交易区间");
  } else {
    risks.push(atrPct < 0.0015 ? "当前波动率偏低，回调信号可能钝化" : "当前波动率偏高，合约止损滑点风险上升");
  }

  let action: StrategySignal["action"] = "HOLD";
  if (position?.side === "long" && (trendDown || rsiNow >= 62)) action = "CLOSE_LONG";
  else if (position?.side === "short" && (trendUp || rsiNow <= 38)) action = "CLOSE_SHORT";
  else if (!position && trendUp && rsiLongPullback && volatilityOk) action = "OPEN_LONG";
  else if (!position && trendDown && rsiShortBounce && volatilityOk) action = "OPEN_SHORT";

  if (action === "HOLD") risks.push("未满足趋势过滤与RSI回调共振，暂不追单");
  if (action === "OPEN_LONG" || action === "OPEN_SHORT") risks.push("该策略参考公开回测思路重构，参数未必适合当前标的，需以样本外回测为准");

  score = clamp(score, -100, 100);
  const confidence = clamp(Math.round(Math.abs(score)), 0, 92);
  const directionText = action === "OPEN_LONG" ? "多头回调" : action === "OPEN_SHORT" ? "空头反弹" : action === "CLOSE_LONG" ? "平多" : action === "CLOSE_SHORT" ? "平空" : "观望";

  return {
    action,
    price: last.close,
    reason: `${directionText}评分 ${score}，RSI ${rsiNow.toFixed(1)}`,
    timestamp: last.time,
    symbol: "ETH_USDT",
    score,
    confidence,
    reasons: reasons.length ? reasons : ["当前趋势与RSI没有形成共振"],
    risks,
    ...buildRiskPlan(action, last.close, atrValue),
  };
}
