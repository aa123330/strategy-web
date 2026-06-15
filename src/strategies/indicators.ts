// 简单移动平均
export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// 指数移动平均
export function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let emaVal = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    emaVal = values[i] * k + emaVal * (1 - k);
  }
  return emaVal;
}

// MACD
export interface MacdResult {
  dif: number;
  dea: number;
  hist: number;
  prev_dif: number;
  prev_dea: number;
  prev_hist: number;
}

export function calcMacd(
  closes: number[],
  fast = 12,
  slow = 26,
  signal = 9
): MacdResult | null {
  if (closes.length < slow + signal) return null;
  const closesForSlow = closes.slice(0, closes.length);
  const fastEma = ema(closesForSlow, fast)!;
  const slowEma = ema(closesForSlow, slow)!;
  const dif = fastEma - slowEma;
  // 计算历史 DIF 用于 DEA
  const histDifs: number[] = [];
  for (let i = slow; i <= closes.length; i++) {
    const slice = closes.slice(0, i);
    const f = ema(slice, fast)!;
    const s = ema(slice, slow)!;
    histDifs.push(f - s);
  }
  if (histDifs.length < signal) return null;
  const dea = ema(histDifs, signal)!;
  const hist = (dif - dea) * 2;

  // 上一个 DIF/DEA
  const prevHistDifs = histDifs.slice(0, -1);
  const prevDea = prevHistDifs.length >= signal ? ema(prevHistDifs, signal) ?? 0 : 0;
  const prevDif = prevHistDifs.at(-1) ?? 0;
  const prevHist = (prevDif - prevDea) * 2;

  return { dif, dea, hist, prev_dif: prevDif, prev_dea: prevDea, prev_hist: prevHist };
}

// 从 K 线数组计算最新 MACD
export function macd(closes: number[], fast = 12, slow = 26, signal = 9): MacdResult | null {
  return calcMacd(closes, fast, slow, signal);
}

export function average(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((sum, value) => sum + value, 0) / period;
}

export function atr(candles: { high: number; low: number; close: number }[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i += 1) {
    const current = candles[i];
    const prev = candles[i - 1];
    trueRanges.push(Math.max(current.high - current.low, Math.abs(current.high - prev.close), Math.abs(current.low - prev.close)));
  }
  return average(trueRanges, period);
}