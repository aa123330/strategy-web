import { useUIStore } from "../store";
import { Activity, BarChart2, TrendingUp, Database } from "lucide-react";

const TABS = [
  { id: "chart" as const, label: "图表分析", icon: BarChart2 },
  { id: "signals" as const, label: "信号面板", icon: TrendingUp },
  { id: "backtest" as const, label: "回测验证", icon: Database },
];

export default function Header() {
  const { tab, setTab } = useUIStore();

  return (
    <header
      style={{
        backgroundColor: "var(--color-bg-card)",
        borderBottom: "1px solid var(--color-border)",
        padding: "0 24px",
        height: "56px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        position: "sticky",
        top: 0,
        zIndex: 50,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <Activity size={20} style={{ color: "var(--color-long)" }} />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "15px", fontWeight: 600, color: "var(--color-text-primary)", letterSpacing: "0.5px" }}>
          ETH SIGNAL
        </span>
        <span style={{ fontSize: "11px", color: "var(--color-text-secondary)", backgroundColor: "var(--color-bg-elevated)", padding: "2px 6px", borderRadius: "4px", fontFamily: "var(--font-mono)" }}>
          PUBLIC DATA · NO API KEY
        </span>
      </div>

      <nav style={{ display: "flex", gap: "4px" }}>
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              padding: "6px 14px",
              borderRadius: "6px",
              border: "none",
              cursor: "pointer",
              fontSize: "13px",
              fontFamily: "var(--font-sans)",
              fontWeight: 500,
              transition: "all 0.15s",
              backgroundColor: tab === id ? "var(--color-bg-elevated)" : "transparent",
              color: tab === id ? "var(--color-text-primary)" : "var(--color-text-secondary)",
            }}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </nav>

      <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", fontFamily: "var(--font-mono)" }}>
        ETH_USDT 永续公开行情
      </div>
    </header>
  );
}
