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

export function rsi(values: number[], period = 14): number | null {
  if (values.length < period + 1) return null;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = values[i] - values[i - 1];
    if (change >= 0) gainSum += change;
    else lossSum += Math.abs(change);
  }

  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  for (let i = period + 1; i < values.length; i += 1) {
    const change = values[i] - values[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
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

export function adx(candles: { high: number; low: number; close: number }[], period = 14): number | null {
  if (candles.length < period * 2 + 1) return null;

  const plusDm: number[] = [];
  const minusDm: number[] = [];
  const trueRanges: number[] = [];

  for (let i = 1; i < candles.length; i += 1) {
    const current = candles[i];
    const prev = candles[i - 1];
    const upMove = current.high - prev.high;
    const downMove = prev.low - current.low;
    plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trueRanges.push(Math.max(current.high - current.low, Math.abs(current.high - prev.close), Math.abs(current.low - prev.close)));
  }

  const dxValues: number[] = [];
  for (let end = period; end <= trueRanges.length; end += 1) {
    const trSum = trueRanges.slice(end - period, end).reduce((sum, value) => sum + value, 0);
    if (trSum === 0) {
      dxValues.push(0);
      continue;
    }
    const plusSum = plusDm.slice(end - period, end).reduce((sum, value) => sum + value, 0);
    const minusSum = minusDm.slice(end - period, end).reduce((sum, value) => sum + value, 0);
    const plusDi = (plusSum / trSum) * 100;
    const minusDi = (minusSum / trSum) * 100;
    const diSum = plusDi + minusDi;
    dxValues.push(diSum === 0 ? 0 : (Math.abs(plusDi - minusDi) / diSum) * 100);
  }

  return average(dxValues, period);
}
