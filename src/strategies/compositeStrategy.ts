import type { CandleRow } from "../services/gatePublicApi";
import { atr, average, macd, sma } from "./indicators";
import type { StrategySignal } from "./dualMa";

interface CompositeOptions {
  fastPeriod: number;
  slowPeriod: number;
  macdFast: number;
  macdSlow: number;
  macdSignal: number;
  atrPeriod?: number;
  rr1?: number;
  rr2?: number;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function buildRiskPlan(action: StrategySignal["action"], entry: number, atrValue: number) {
  if (action !== "OPEN_LONG" && action !== "OPEN_SHORT") return {};
  const riskDistance = Math.max(atrValue * 1.5, entry * 0.004);
  const direction = action === "OPEN_LONG" ? 1 : -1;
  const stopLoss = entry - direction * riskDistance;
  const takeProfit1 = entry + direction * riskDistance * 2;
  const takeProfit2 = entry + direction * riskDistance * 3;
  return {
    entry,
    stopLoss,
    takeProfit1,
    takeProfit2,
    riskReward: 2,
    atr: atrValue,
  };
}

export function generateCompositeSignal(candles: CandleRow[], options: CompositeOptions): StrategySignal {
  const last = candles.at(-1);
  if (!last) {
    return { action: "HOLD", price: 0, reason: "无K线数据", timestamp: 0, symbol: "ETH_USDT", score: 0, confidence: 0 };
  }

  const required = Math.max(options.slowPeriod + 2, options.macdSlow + options.macdSignal + 2, (options.atrPeriod ?? 14) + 2, 60);
  if (candles.length < required) {
    return {
      action: "HOLD",
      price: last.close,
      reason: `综合策略数据不足，需要至少${required}根K线`,
      timestamp: last.time,
      symbol: "ETH_USDT",
      score: 0,
      confidence: 0,
      reasons: [`当前仅有${candles.length}根K线`],
      risks: ["样本不足时不生成开仓建议"],
    };
  }

  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const prevCloses = closes.slice(0, -1);
  const fastNow = sma(closes, options.fastPeriod);
  const fastPrev = sma(prevCloses, options.fastPeriod);
  const slowNow = sma(closes, options.slowPeriod);
  const slowPrev = sma(prevCloses, options.slowPeriod);
  const macdNow = macd(closes, options.macdFast, options.macdSlow, options.macdSignal);
  const atrValue = atr(candles, options.atrPeriod ?? 14);
  const avgVolume = average(volumes.slice(0, -1), 20);
  const currentVolume = last.volume;
  const recentHigh = Math.max(...candles.slice(-20).map((c) => c.high));
  const recentLow = Math.min(...candles.slice(-20).map((c) => c.low));

  if (!fastNow || !fastPrev || !slowNow || !slowPrev || !macdNow || !atrValue || !avgVolume) {
    return { action: "HOLD", price: last.close, reason: "综合指标尚未完全形成", timestamp: last.time, symbol: "ETH_USDT", score: 0, confidence: 0 };
  }

  let longScore = 0;
  let shortScore = 0;
  const reasons: string[] = [];
  const risks: string[] = [];

  const goldenCross = fastPrev <= slowPrev && fastNow > slowNow;
  const deathCross = fastPrev >= slowPrev && fastNow < slowNow;
  const trendUp = fastNow > slowNow && last.close > slowNow;
  const trendDown = fastNow < slowNow && last.close < slowNow;
  const macdBull = macdNow.dif > macdNow.dea && macdNow.hist > macdNow.prev_hist;
  const macdBear = macdNow.dif < macdNow.dea && macdNow.hist < macdNow.prev_hist;
  const volumeBoost = currentVolume > avgVolume * 1.15;
  const atrPct = atrValue / last.close;
  const volatilityOk = atrPct >= 0.002 && atrPct <= 0.025;
  const nearHigh = (recentHigh - last.close) / last.close < 0.003;
  const nearLow = (last.close - recentLow) / last.close < 0.003;

  if (goldenCross) {
    longScore += 30;
    reasons.push("MA快线上穿慢线，出现趋势转强信号");
  }
  if (deathCross) {
    shortScore += 30;
    reasons.push("MA快线下穿慢线，出现趋势转弱信号");
  }
  if (trendUp) {
    longScore += 20;
    reasons.push("价格位于慢线之上，趋势偏多");
  }
  if (trendDown) {
    shortScore += 20;
    reasons.push("价格位于慢线之下，趋势偏空");
  }
  if (macdBull) {
    longScore += 25;
    reasons.push("MACD多头排列且柱体增强");
  }
  if (macdBear) {
    shortScore += 25;
    reasons.push("MACD空头排列且柱体转弱");
  }
  if (volumeBoost) {
    longScore += trendUp || goldenCross ? 10 : 0;
    shortScore += trendDown || deathCross ? 10 : 0;
    reasons.push("成交量高于20周期均量，信号有效性提高");
  }
  if (volatilityOk) {
    longScore += trendUp || goldenCross ? 10 : 0;
    shortScore += trendDown || deathCross ? 10 : 0;
    reasons.push("ATR波动率处于可交易区间");
  } else {
    risks.push(atrPct < 0.002 ? "当前波动率偏低，容易出现假突破" : "当前波动率偏高，止损距离可能扩大");
  }
  if (nearHigh) {
    longScore -= 8;
    risks.push("价格接近20周期高点，做多存在追高风险");
  }
  if (nearLow) {
    shortScore -= 8;
    risks.push("价格接近20周期低点，做空存在追空风险");
  }

  const score = clamp(longScore - shortScore, -100, 100);
  const absScore = Math.abs(score);
  const confidence = clamp(Math.round(absScore), 0, 95);
  let action: StrategySignal["action"] = "HOLD";

  if (score >= 65 && volatilityOk) action = "OPEN_LONG";
  if (score <= -65 && volatilityOk) action = "OPEN_SHORT";
  if (action === "HOLD") {
    risks.push("综合评分未达到开仓阈值，建议继续等待确认");
  }

  const directionText = action === "OPEN_LONG" ? "做多" : action === "OPEN_SHORT" ? "做空" : "观望";
  const reason = `${directionText}评分 ${score}，置信度 ${confidence}%`;

  return {
    action,
    price: last.close,
    reason,
    timestamp: last.time,
    symbol: "ETH_USDT",
    score,
    confidence,
    reasons: reasons.length ? reasons : ["当前无明确趋势共振信号"],
    risks,
    ...buildRiskPlan(action, last.close, atrValue),
  };
}
