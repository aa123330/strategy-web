import { create } from "zustand";
import type { CandleRow, Contract } from "../services/gatePublicApi";
import type { Account, Position } from "../services/gatePrivateApi";
import type { StrategySignal } from "../strategies/dualMa";
import type { OrderDraft } from "../strategies/signalProcessor";

// === 数据源类型 ===
export type DataSourceName = "auto" | "gate" | "binance" | "okx" | "fallback";
export type ConnectionStatus = "idle" | "connecting" | "connected" | "error" | "disconnected";

// === 凭证状态 ===
interface CredentialsState {
  key: string | null;
  secret: string | null;
  connected: boolean;
  setCredentials: (key: string, secret: string) => void;
  clearCredentials: () => void;
}

export const useCredentialsStore = create<CredentialsState>((set) => ({
  key: null,
  secret: null,
  connected: false,
  setCredentials: (key, secret) => set({ key, secret, connected: true }),
  clearCredentials: () => set({ key: null, secret: null, connected: false }),
}));

// === 市场数据状态 ===
interface MarketState {
  candles: CandleRow[];
  contract: Contract | null;
  dataSource: string;
  activeSource: DataSourceName;
  preferredSource: DataSourceName;
  connectionStatus: ConnectionStatus;
  connectionError: string | null;
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
  setConnectionStatus: (status: ConnectionStatus) => void;
  setConnectionError: (e: string | null) => void;
}

export const useMarketStore = create<MarketState>((set) => ({
  candles: [],
  contract: null,
  dataSource: "gate",
  activeSource: "gate",
  preferredSource: "auto",
  connectionStatus: "idle",
  connectionError: null,
  interval: "15m",
  loading: false,
  error: null,
  setCandles: (candles, source) =>
    set({ candles, dataSource: source, loading: false, error: null }),
  setContract: (contract) => set({ contract }),
  setInterval: (interval) => set({ interval }),
  setLoading: (v) => set({ loading: v }),
  setError: (e) => set({ error: e, loading: false }),
  setActiveSource: (source, error = null) =>
    set({ activeSource: source, connectionError: error }),
  setPreferredSource: (source) => set({ preferredSource: source, activeSource: source === "auto" ? "gate" : source }),
  setConnectionStatus: (status) => set({ connectionStatus: status }),
  setConnectionError: (e) => set({ connectionError: e }),
}));

// === 账户 / 持仓状态 ===
interface AccountState {
  account: Account | null;
  position: Position | null;
  loading: boolean;
  error: string | null;
  setAccount: (a: Account | null) => void;
  setPosition: (p: Position | null) => void;
  setLoading: (v: boolean) => void;
  setError: (e: string | null) => void;
}

export const useAccountStore = create<AccountState>((set) => ({
  account: null,
  position: null,
  loading: false,
  error: null,
  setAccount: (a) => set({ account: a }),
  setPosition: (p) => set({ position: p }),
  setLoading: (v) => set({ loading: v }),
  setError: (e) => set({ error: e, loading: false }),
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
  strategy: "dual_ma",
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

// === 订单状态 ===
interface OrderState {
  preview: OrderDraft | null;
  decisionReason: string;
  orderResult: unknown;
  submitting: boolean;
  submitError: string | null;
  success: boolean;
  openUsdt: number;
  setPreview: (o: OrderDraft | null, reason: string) => void;
  setOpenUsdt: (v: number) => void;
  setSubmitting: (v: boolean) => void;
  setSubmitResult: (r: unknown, err: string | null) => void;
  clearResult: () => void;
}

export const useOrderStore = create<OrderState>((set) => ({
  preview: null,
  decisionReason: "",
  orderResult: null,
  submitting: false,
  submitError: null,
  success: false,
  openUsdt: 5,
  setPreview: (o, reason) => set({ preview: o, decisionReason: reason }),
  setOpenUsdt: (v) => set({ openUsdt: v }),
  setSubmitting: (v) => set({ submitting: v }),
  setSubmitResult: (r, err) =>
    set({ orderResult: r, submitError: err, submitting: false, success: err === null }),
  clearResult: () => set({ orderResult: null, submitError: null, success: false }),
}));

// === UI 状态 ===
type Tab = "chart" | "signals";

interface UIState {
  tab: Tab;
  setTab: (t: Tab) => void;
}

export const useUIStore = create<UIState>((set) => ({
  tab: "chart",
  setTab: (t) => set({ tab: t }),
}));
