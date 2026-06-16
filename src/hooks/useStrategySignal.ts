import { useEffect, useRef } from "react";
import { useMarketStore, useStrategyStore } from "../store";
import { generateCompositeSignal } from "../strategies/compositeStrategy";
import { generateDualMaSignal } from "../strategies/dualMa";
import { generateMacdSignal } from "../strategies/macdStrategy";
import { generateSmaRsiPullbackSignal } from "../strategies/smaRsiPullback";

export function useStrategySignal() {
  const { candles } = useMarketStore();
  const {
    strategy,
    fastPeriod,
    slowPeriod,
    macdFast,
    macdSlow,
    macdSignal,
    rsiPeriod,
    longRsiMax,
    shortRsiMin,
    setSignal,
    addHistory,
  } = useStrategyStore();
  const lastRecordedRef = useRef<string>("");

  useEffect(() => {
    if (!candles.length) {
      setSignal(null);
      return;
    }

    const signal = strategy === "composite"
      ? generateCompositeSignal(candles, { fastPeriod, slowPeriod, macdFast, macdSlow, macdSignal })
      : strategy === "macd"
        ? generateMacdSignal(candles, macdFast, macdSlow, macdSignal, null)
        : strategy === "sma_rsi_pullback"
          ? generateSmaRsiPullbackSignal(candles, { fastPeriod, slowPeriod, rsiPeriod, longRsiMax, shortRsiMin }, null)
          : generateDualMaSignal(candles, fastPeriod, slowPeriod, null);

    setSignal(signal);

    if (signal.action !== "HOLD") {
      const key = `${signal.timestamp}-${signal.action}-${signal.price}`;
      if (lastRecordedRef.current !== key) {
        lastRecordedRef.current = key;
        addHistory(signal);
      }
    }
  }, [addHistory, candles, fastPeriod, longRsiMax, macdFast, macdSignal, macdSlow, rsiPeriod, setSignal, shortRsiMin, slowPeriod, strategy]);
}
