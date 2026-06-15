import type { CandleRow } from "../services/gatePublicApi";
import { macd } from "./indicators";
import type { StrategySignal, PositionInfo } from "./dualMa";

export function generateMacdSignal(
  candles: CandleRow[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
  position: PositionInfo | null
): StrategySignal {
  const last = candles.at(-1);
  if (!last) {
    return { action: "HOLD", price: 0, reason: "无K线数据", timestamp: 0, symbol: "ETH_USDT" };
  }

  const closes = candles.map((c) => c.close);
  const values = macd(closes, fastPeriod, slowPeriod, signalPeriod);

  if (!values) {
    return { action: "HOLD", price: last.close, reason: "MACD数据不足", timestamp: last.time, symbol: "ETH_USDT" };
  }

  const goldenCross =
    values.prev_dif <= values.prev_dea &&
    values.dif > values.dea &&
    values.hist > values.prev_hist;
  const deathCross =
    values.prev_dif >= values.prev_dea &&
    values.dif < values.dea &&
    values.hist < values.prev_hist;

  if (!position) {
    if (goldenCross) return { action: "OPEN_LONG", price: last.close, reason: "MACD金叉且动能增强", timestamp: last.time, symbol: "ETH_USDT" };
    if (deathCross) return { action: "OPEN_SHORT", price: last.close, reason: "MACD死叉且动能转弱", timestamp: last.time, symbol: "ETH_USDT" };
    return { action: "HOLD", price: last.close, reason: "无仓且无MACD信号", timestamp: last.time, symbol: "ETH_USDT" };
  }

  if (position.side === "long" && deathCross) {
    return { action: "CLOSE_LONG", price: last.close, reason: "MACD死叉平多", timestamp: last.time, symbol: "ETH_USDT" };
  }
  if (position.side === "short" && goldenCross) {
    return { action: "CLOSE_SHORT", price: last.close, reason: "MACD金叉平空", timestamp: last.time, symbol: "ETH_USDT" };
  }

  return { action: "HOLD", price: last.close, reason: "持仓中未触发MACD反向信号", timestamp: last.time, symbol: "ETH_USDT" };
}