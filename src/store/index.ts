import { create } from "zustand";
import type { CandleRow, Contract } from "../services/gatePublicApi";
import type { StrategySignal } from "../strategies/dualMa";

// === 数据源类型 ===
export type DataSourceName = "auto" | "gate" | "binance" | "okx" | "fallback";
export type HistoricalSourceName = "gate" | "okx";
export type ConnectionStatus = "idle" | "connecting" | "connected" | "error" | "disconnected";

// === 市场数据状态 ===
interface MarketState {
  candles: CandleRow[];
  contract: Contract | null;
  dataSource: string;
  activeSource: DataSourceName;
  preferredSource: DataSourceName;
  historicalSource: HistoricalSourceName;
  connectionStatus: ConnectionStatus;
  connectionError: string | null;
  lastUpdatedAt: number | null;
  updateCount: number;
  interval: string;
  loading: boolean;
  error: string | null;
  setCandles: (candles: CandleRow[], source: string) => void;
  setContract: (contract: Contract) => void;
  setInterval: (interval: string) => void;
  setLoading: (v: boolean) => void;
  setError: (e: string | null) => void;
  setActiveSource: (source: DataSourceName, error?: string | null) => void;
  setPreferredSource: (source: DataSourceName) => void;
  setHistoricalSource: (source: HistoricalSourceName) => void;
  setConnectionStatus: (status: ConnectionStatus) => void;
  setConnectionError: (e: string | null) => void;
}

export const useMarketStore = create<MarketState>((set) => ({
  candles: [],
  contract: null,
  dataSource: "gate",
  activeSource: "gate",
  preferredSource: "auto",
  historicalSource: "okx",
  connectionStatus: "idle",
  connectionError: null,
  lastUpdatedAt: null,
  updateCount: 0,
  interval: "15m",
  loading: false,
  error: null,
  setCandles: (candles, source) =>
    set((state) => ({
      candles,
      dataSource: source,
      loading: false,
      error: null,
      lastUpdatedAt: Date.now(),
      updateCount: state.updateCount + 1,
    })),
  setContract: (contract) => set({ contract }),
  setInterval: (interval) => set({ interval }),
  setLoading: (v) => set({ loading: v }),
  setError: (e) => set({ error: e, loading: false }),
  setActiveSource: (source, error = null) =>
    set({ activeSource: source, connectionError: error }),
  setPreferredSource: (source) => set({ preferredSource: source, activeSource: source === "auto" ? "gate" : source }),
  setHistoricalSource: (source) => set({ historicalSource: source }),
  setConnectionStatus: (status) => set({ connectionStatus: status }),
  setConnectionError: (e) => set({ connectionError: e }),
}));

// === 策略状态 ===
type StrategyName = "composite" | "dual_ma" | "macd";

interface StrategyState {
  strategy: StrategyName;
  fastPeriod: number;
  slowPeriod: number;
  macdFast: number;
  macdSlow: number;
  macdSignal: number;
  signal: StrategySignal | null;
  signalHistory: StrategySignal[];
  setStrategy: (s: StrategyName) => void;
  setParams: (
    p: Partial<
      Omit<
        StrategyState,
        | "strategy"
        | "signal"
        | "signalHistory"
        | "setStrategy"
        | "setParams"
        | "addHistory"
      >
    >
  ) => void;
  setSignal: (s: StrategySignal | null) => void;
  addHistory: (s: StrategySignal) => void;
  clearHistory: () => void;
}

export const useStrategyStore = create<StrategyState>((set) => ({
  strategy: "composite",
  fastPeriod: 20,
  slowPeriod: 60,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  signal: null,
  signalHistory: [],
  setStrategy: (s) => set({ strategy: s }),
  setParams: (p) => set(p),
  setSignal: (s) => set({ signal: s }),
  addHistory: (s) =>
    set((state) => ({
      signalHistory: [s, ...state.signalHistory].slice(0, 20),
    })),
  clearHistory: () => set({ signalHistory: [] }),
}));

// === UI 状态 ===
export type Tab = "chart" | "signals" | "backtest";

function getInitialTab(): Tab {
  if (typeof window === "undefined") return "chart";
  const hashTab = window.location.hash.replace(/^#\/?/, "") as Tab;
  if (["chart", "signals", "backtest"].includes(hashTab)) return hashTab;
  const savedTab = window.localStorage.getItem("strategy-web.active-tab") as Tab | null;
  return savedTab && ["chart", "signals", "backtest"].includes(savedTab) ? savedTab : "chart";
}

interface UIState {
  tab: Tab;
  setTab: (t: Tab) => void;
}

export const useUIStore = create<UIState>((set) => ({
  tab: getInitialTab(),
  setTab: (t) => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("strategy-web.active-tab", t);
      window.history.replaceState(null, "", `#${t}`);
    }
    set({ tab: t });
  },
}));
