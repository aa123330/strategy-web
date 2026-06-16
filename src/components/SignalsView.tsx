import { useMarketStore, useStrategyStore } from "../store";
import { formatTimestamp } from "../utils/formatters";
import { TrendingUp, TrendingDown, Minus, Clock, Shield, Target, AlertTriangle, Gauge } from "lucide-react";

const ACTION_CONFIG = {
  OPEN_LONG: { label: "建议做多", color: "var(--color-long)", bg: "rgba(0,255,136,0.08)", icon: TrendingUp },
  OPEN_SHORT: { label: "建议做空", color: "var(--color-short)", bg: "rgba(255,51,102,0.08)", icon: TrendingDown },
  CLOSE_LONG: { label: "平多", color: "var(--color-short)", bg: "rgba(255,51,102,0.08)", icon: TrendingDown },
  CLOSE_SHORT: { label: "平空", color: "var(--color-long)", bg: "rgba(0,255,136,0.08)", icon: TrendingUp },
  HOLD: { label: "观望", color: "var(--color-hold)", bg: "rgba(136,136,136,0.08)", icon: Minus },
};

type CurrentSignal = NonNullable<ReturnType<typeof useStrategyStore.getState>["signal"]>;

function fmtPrice(value?: number) {
  return typeof value === "number" ? `$${value.toFixed(2)}` : "--";
}

function SignalCard({ signal }: { signal: CurrentSignal }) {
  const cfg = ACTION_CONFIG[signal.action];
  const Icon = cfg.icon;
  const confidence = signal.confidence ?? 0;

  return (
    <div style={{ background: cfg.bg, border: `1px solid ${cfg.color}33`, borderRadius: "12px", padding: "24px", display: "flex", flexDirection: "column", gap: "18px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px", flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <Icon size={28} style={{ color: cfg.color }} />
          <div>
            <div style={{ fontSize: "34px", fontWeight: 700, color: cfg.color, fontFamily: "var(--font-mono)", lineHeight: 1.1 }}>{cfg.label}</div>
            <div style={{ marginTop: "6px", fontSize: "12px", color: "var(--color-text-secondary)" }}>{signal.reason}</div>
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", marginBottom: "4px" }}>当前价格</div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: "24px", color: "var(--color-text-primary)", fontWeight: 600 }}>{fmtPrice(signal.price)}</div>
          <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", fontFamily: "var(--font-mono)", marginTop: "4px" }}>{formatTimestamp(signal.timestamp)}</div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(120px, 1fr))", gap: "10px" }}>
        <DataItem label="信号评分" value={typeof signal.score === "number" ? String(signal.score) : "--"} color={cfg.color} icon={<Gauge size={13} />} />
        <DataItem label="置信度" value={`${confidence}%`} color={cfg.color} />
        <DataItem label="入场参考" value={fmtPrice(signal.entry ?? signal.price)} />
        <DataItem label="ATR" value={typeof signal.atr === "number" ? signal.atr.toFixed(2) : "--"} />
        <DataItem label="风险收益比" value={signal.riskReward ? `1 : ${signal.riskReward}` : "--"} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "10px" }}>
        <DataItem label="止损" value={fmtPrice(signal.stopLoss)} color="var(--color-short)" icon={<Shield size={13} />} />
        <DataItem label="止盈1" value={fmtPrice(signal.takeProfit1)} color="var(--color-long)" icon={<Target size={13} />} />
        <DataItem label="止盈2" value={fmtPrice(signal.takeProfit2)} color="var(--color-long)" icon={<Target size={13} />} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
        <InfoList title="信号依据" items={signal.reasons ?? [signal.reason]} />
        <InfoList title="风险提示" items={signal.risks?.length ? signal.risks : ["当前未发现额外风险提示"]} warning />
      </div>
    </div>
  );
}

export default function SignalsView() {
  const { strategy, setStrategy, fastPeriod, setParams, slowPeriod, rsiPeriod, longRsiMax, shortRsiMin, adxPeriod, minAdx, atrPeriod, signal, signalHistory } = useStrategyStore();
  const { candles } = useMarketStore();

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "20px", display: "flex", flexDirection: "column", gap: "20px" }}>
      <div style={{ backgroundColor: "var(--color-bg-card)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "16px" }}>
        <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginBottom: "12px" }}>选择策略</div>
        <div style={{ display: "flex", gap: "8px" }}>
          {[
            { id: "composite" as const, label: "综合评分", desc: "趋势 + 动量 + ATR风控" },
            { id: "dual_ma" as const, label: "双均线", desc: `MA${fastPeriod} / MA${slowPeriod}` },
            { id: "sma_rsi_pullback" as const, label: "SMA+RSI", desc: "趋势过滤 + 回调入场" },
            { id: "macd" as const, label: "MACD", desc: "12 / 26 / 9" },
          ].map((s) => (
            <button
              key={s.id}
              onClick={() => setStrategy(s.id)}
              style={{
                flex: 1,
                padding: "10px 16px",
                borderRadius: "8px",
                border: `1px solid ${strategy === s.id ? "var(--color-btn-primary)" : "var(--color-border)"}`,
                backgroundColor: strategy === s.id ? "rgba(26,115,232,0.12)" : "transparent",
                color: strategy === s.id ? "var(--color-text-primary)" : "var(--color-text-secondary)",
                cursor: "pointer",
                textAlign: "left",
                transition: "all 0.15s",
              }}
            >
              <div style={{ fontSize: "14px", fontWeight: 500 }}>{s.label}</div>
              <div style={{ fontSize: "11px", fontFamily: "var(--font-mono)", color: "var(--color-text-secondary)", marginTop: "4px" }}>{s.desc}</div>
            </button>
          ))}
        </div>

        <div style={{ marginTop: "16px", display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "12px" }}>
          <ParamInput label="快线周期" value={fastPeriod} onChange={(v) => setParams({ fastPeriod: v })} min={5} max={100} step={1} />
          <ParamInput label="慢线周期" value={slowPeriod} onChange={(v) => setParams({ slowPeriod: v })} min={10} max={200} step={1} />
          <ParamInput label="RSI周期" value={rsiPeriod} onChange={(v) => setParams({ rsiPeriod: v })} min={5} max={50} step={1} disabled={strategy !== "sma_rsi_pullback"} />
          <ParamInput label="做多RSI上限" value={longRsiMax} onChange={(v) => setParams({ longRsiMax: v })} min={20} max={55} step={1} disabled={strategy !== "sma_rsi_pullback"} />
          <ParamInput label="做空RSI下限" value={shortRsiMin} onChange={(v) => setParams({ shortRsiMin: v })} min={45} max={80} step={1} disabled={strategy !== "sma_rsi_pullback"} />
          <ParamInput label="ADX周期" value={adxPeriod} onChange={(v) => setParams({ adxPeriod: v })} min={7} max={40} step={1} disabled={strategy !== "sma_rsi_pullback"} />
          <ParamInput label="最小ADX" value={minAdx} onChange={(v) => setParams({ minAdx: v })} min={10} max={45} step={1} disabled={strategy !== "sma_rsi_pullback"} />
          <ParamInput label="ATR周期" value={atrPeriod} onChange={(v) => setParams({ atrPeriod: v })} min={5} max={50} step={1} disabled={strategy !== "sma_rsi_pullback"} />
        </div>
      </div>

      {signal ? (
        <SignalCard signal={signal} />
      ) : (
        <div style={{ textAlign: "center", padding: "40px", color: "var(--color-text-secondary)", fontSize: "14px" }}>等待 K 线数据生成信号...</div>
      )}

      <div style={{ backgroundColor: "var(--color-bg-card)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", display: "flex", alignItems: "center", gap: "6px" }}>
            <Clock size={12} />最近方向信号历史
          </div>
          <span style={{ fontSize: "11px", color: "var(--color-text-secondary)", fontFamily: "var(--font-mono)" }}>{candles.length} 根K线</span>
        </div>

        {signalHistory.length === 0 ? (
          <div style={{ textAlign: "center", padding: "20px", color: "var(--color-text-secondary)", fontSize: "13px" }}>暂无历史信号</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "4px", maxHeight: "300px", overflowY: "auto" }}>
            {signalHistory.map((sig, i) => {
              const cfg = ACTION_CONFIG[sig.action];
              return (
                <div key={`${sig.timestamp}-${i}`} style={{ display: "grid", gridTemplateColumns: "130px 90px 90px 80px 1fr", alignItems: "center", gap: "12px", padding: "8px 10px", borderRadius: "6px", backgroundColor: i === 0 ? cfg.bg : "transparent", border: i === 0 ? `1px solid ${cfg.color}22` : "1px solid transparent" }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--color-text-secondary)" }}>{formatTimestamp(sig.timestamp)}</span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: "12px", fontWeight: 600, color: cfg.color }}>{cfg.label}</span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--color-text-primary)" }}>{fmtPrice(sig.price)}</span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: "12px", color: cfg.color }}>{sig.confidence ?? "--"}%</span>
                  <span style={{ fontSize: "11px", color: "var(--color-text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sig.reason}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function ParamInput({ label, value, onChange, min, max, step, disabled }: {
  label: string; value: number; onChange: (v: number) => void; min: number; max: number; step: number; disabled?: boolean;
}) {
  return (
    <div>
      <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", marginBottom: "4px" }}>{label}</div>
      <input type="number" value={value} onChange={(e) => onChange(Number(e.target.value))} min={min} max={max} step={step} disabled={disabled} style={{ width: "100%", boxSizing: "border-box", opacity: disabled ? 0.5 : 1 }} />
    </div>
  );
}

function DataItem({ label, value, color, icon }: { label: string; value: string; color?: string; icon?: React.ReactNode }) {
  return (
    <div style={{ backgroundColor: "rgba(255,255,255,0.03)", border: "1px solid var(--color-border)", borderRadius: "8px", padding: "10px" }}>
      <div style={{ fontSize: "10px", color: "var(--color-text-secondary)", marginBottom: "4px", display: "flex", alignItems: "center", gap: "4px" }}>{icon}{label}</div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: "14px", color: color || "var(--color-text-primary)", fontWeight: 600 }}>{value}</div>
    </div>
  );
}

function InfoList({ title, items, warning }: { title: string; items: string[]; warning?: boolean }) {
  return (
    <div style={{ backgroundColor: warning ? "rgba(255,170,0,0.06)" : "rgba(255,255,255,0.03)", border: `1px solid ${warning ? "rgba(255,170,0,0.2)" : "var(--color-border)"}`, borderRadius: "8px", padding: "12px" }}>
      <div style={{ fontSize: "12px", color: warning ? "#ffaa00" : "var(--color-text-primary)", marginBottom: "8px", display: "flex", alignItems: "center", gap: "6px" }}>
        {warning && <AlertTriangle size={13} />}{title}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        {items.map((item, idx) => (
          <div key={idx} style={{ fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.5 }}>• {item}</div>
        ))}
      </div>
    </div>
  );
}
