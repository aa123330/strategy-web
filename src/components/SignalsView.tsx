import { useEffect, useState } from "react";
import { useMarketStore, useStrategyStore } from "../store";
import { getRealtimeSignal, type RealtimeSignalResult } from "../services/localDataApi";
import { formatTimestamp } from "../utils/formatters";
import { TrendingUp, TrendingDown, Minus, Clock, Shield, Target, AlertTriangle, Gauge, RefreshCw } from "lucide-react";

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

function pct(value?: number | null, decimals = 2) {
  return typeof value === "number" ? `${(value * 100).toFixed(decimals)}%` : "--";
}

function fmtIndicator(value?: number | null, decimals = 2) {
  return typeof value === "number" ? value.toFixed(decimals) : "--";
}

function biasLabel(value: "bull" | "bear" | "neutral") {
  if (value === "bull") return "多头";
  if (value === "bear") return "空头";
  return "中性";
}

function biasColor(value: "bull" | "bear" | "neutral") {
  if (value === "bull") return "var(--color-long)";
  if (value === "bear") return "var(--color-short)";
  return "var(--color-hold)";
}

function actionLabel(action: RealtimeSignalResult["evaluation"]["finalAction"]) {
  if (action === "open_long") return "允许做多";
  if (action === "open_short") return "允许做空";
  return "空仓观望";
}

function LockedStrategySignalCard({ data, loading, onRefresh }: { data: RealtimeSignalResult | null; loading: boolean; onRefresh: () => void }) {
  const action = data?.evaluation.finalAction ?? "hold";
  const actionColor = action === "open_long" ? "var(--color-long)" : action === "open_short" ? "var(--color-short)" : "var(--color-hold)";
  const latestCandle = data?.evaluation.latestCandle;
  const diagnostics = data?.evaluation.marketBreadthDiagnostics;

  return (
    <div style={{ backgroundColor: "var(--color-bg-card)", border: `1px solid ${actionColor}44`, borderRadius: "12px", padding: "18px", display: "flex", flexDirection: "column", gap: "14px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px", flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginBottom: "6px" }}>锁定策略 V1 实时状态</div>
          <div style={{ fontSize: "24px", fontWeight: 700, color: actionColor }}>{data ? actionLabel(action) : loading ? "读取中..." : "暂无数据"}</div>
          <div style={{ marginTop: "6px", fontSize: "12px", color: "var(--color-text-secondary)" }}>{data?.config.name ?? "主策略增强版 V1"}</div>
        </div>
        <button onClick={onRefresh} disabled={loading} style={{ display: "flex", alignItems: "center", gap: "6px", padding: "8px 12px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "transparent", color: "var(--color-text-primary)", cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.6 : 1 }}>
          <RefreshCw size={14} />刷新
        </button>
      </div>

      {data ? (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(120px, 1fr))", gap: "10px" }}>
            <DataItem label="标的/周期" value={`${data.config.exchange.toUpperCase()} ${data.config.symbol} ${data.config.interval}`} />
            <DataItem label="当前价格" value={fmtPrice(latestCandle?.close)} color={actionColor} />
            <DataItem label="最新K线" value={latestCandle ? formatTimestamp(latestCandle.time) : "--"} />
            <DataItem label="主信号" value={data.evaluation.rawSignal === "long" ? "做多" : data.evaluation.rawSignal === "short" ? "做空" : "无"} color={actionColor} />
            <DataItem label="本地K线" value={`${data.candleCount} 根`} />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(120px, 1fr))", gap: "10px" }}>
            <DataItem label="高周期状态" value={biasLabel(data.evaluation.higherTimeframeBias)} color={biasColor(data.evaluation.higherTimeframeBias)} />
            <DataItem label="市场广度" value={biasLabel(data.evaluation.marketBreadthBias)} color={biasColor(data.evaluation.marketBreadthBias)} />
            <DataItem label="快/慢均线" value={`${fmtIndicator(data.evaluation.indicators.fastSma)} / ${fmtIndicator(data.evaluation.indicators.slowSma)}`} />
            <DataItem label="ATR" value={fmtIndicator(data.evaluation.indicators.atr)} />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(120px, 1fr))", gap: "10px" }}>
            <DataItem label="方向限制" value={data.evaluation.checks.direction ? "通过" : "未通过"} color={data.evaluation.checks.direction ? "var(--color-long)" : "var(--color-hold)"} />
            <DataItem label="高周期过滤" value={data.evaluation.checks.higherTimeframe ? "通过" : "未通过"} color={data.evaluation.checks.higherTimeframe ? "var(--color-long)" : "var(--color-hold)"} />
            <DataItem label="广度过滤" value={data.evaluation.checks.marketBreadth ? "通过" : "未通过"} color={data.evaluation.checks.marketBreadth ? "var(--color-long)" : "var(--color-hold)"} />
            <DataItem label="趋势质量" value={data.evaluation.checks.trendQuality ? "通过" : "未通过"} color={data.evaluation.checks.trendQuality ? "var(--color-long)" : "var(--color-hold)"} />
          </div>

          {diagnostics && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(120px, 1fr))", gap: "10px" }}>
              <DataItem label="广度有效标的" value={`${diagnostics.eligibleSymbols.length} / ${diagnostics.requestedSymbols.length}`} />
              <DataItem label="平均有效标的" value={diagnostics.averageValidSymbols.toFixed(2)} />
              <DataItem label="覆盖率" value={pct(diagnostics.coverageRatio)} />
              <DataItem label="状态占比" value={`多 ${pct(diagnostics.stateCounts.bull / Math.max(1, diagnostics.usableBucketCount), 1)} / 空 ${pct(diagnostics.stateCounts.bear / Math.max(1, diagnostics.usableBucketCount), 1)}`} />
            </div>
          )}

          <InfoList title="实时判定原因" items={data.evaluation.reasons.length ? data.evaluation.reasons : ["当前无额外判定原因。"]} />
          <InfoList title="使用说明" items={["该面板读取 configs/locked-strategy-v1.json，按本地最新K线评估锁定策略状态。", "信号仅用于策略研究和本地验证，不构成任何真实交易建议。"]} warning />
        </>
      ) : (
        <div style={{ padding: "22px", borderRadius: "8px", background: "rgba(255,255,255,0.03)", color: "var(--color-text-secondary)", fontSize: "13px" }}>未能读取锁定策略实时状态。请确认本地后端已启动，且 OKX / ETH_USDT / 1h 数据已完成补充。</div>
      )}
    </div>
  );
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
  const [lockedSignal, setLockedSignal] = useState<RealtimeSignalResult | null>(null);
  const [lockedSignalLoading, setLockedSignalLoading] = useState(false);

  const refreshLockedSignal = async () => {
    setLockedSignalLoading(true);
    const result = await getRealtimeSignal();
    setLockedSignal(result);
    setLockedSignalLoading(false);
  };

  useEffect(() => {
    let cancelled = false;
    void getRealtimeSignal().then((result) => {
      if (!cancelled) setLockedSignal(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "20px", display: "flex", flexDirection: "column", gap: "20px" }}>
      <LockedStrategySignalCard data={lockedSignal} loading={lockedSignalLoading} onRefresh={refreshLockedSignal} />

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
