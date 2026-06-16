import { Header, ChartView, SignalsView, BacktestView } from "./components";
import { useUIStore } from "./store";
import { useMarketData } from "./hooks/useMarketData";
import { useStrategySignal } from "./hooks/useStrategySignal";

export default function App() {
  const { tab } = useUIStore();

  useMarketData();
  useStrategySignal();

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", backgroundColor: "var(--color-bg-base)" }}>
      <Header />

      <main style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        {tab === "chart" && <ChartView />}
        {tab === "signals" && <SignalsView />}
        {tab === "backtest" && <BacktestView />}
      </main>
    </div>
  );
}
