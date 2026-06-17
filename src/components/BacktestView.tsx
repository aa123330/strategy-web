import { useCallback, useEffect, useState } from "react";
import { BarChart3, Database, RefreshCw } from "lucide-react";
import { useMarketStore, useStrategyStore, type HigherTimeframe } from "../store";
import { backfillLocalCandles, getBackfillJob, getLocalCandles, runBacktest, type BackfillJob, type BacktestMetrics, type BacktestResult, type CandleRange, type DirectionBreakdown, type TradeDirection } from "../services/localDataApi";

const BACKFILL_JOB_STORAGE_KEY = "strategy-web.backfill-job";
const BACKFILL_FORM_STORAGE_KEY = "strategy-web.backfill-form";

function saveBackfillJob(job: BackfillJob | null) {
  if (!job) {
    window.localStorage.removeItem(BACKFILL_JOB_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(BACKFILL_JOB_STORAGE_KEY, JSON.stringify({ id: job.id }));
}

function loadBackfillJobId() {
  try {
    const raw = window.localStorage.getItem(BACKFILL_JOB_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as { id?: string }).id ?? null : null;
  } catch {
    return null;
  }
}

function loadBackfillForm() {
  try {
    const raw = window.localStorage.getItem(BACKFILL_FORM_STORAGE_KEY);
    return raw ? JSON.parse(raw) as { days?: number; symbols?: string; intervals?: string } : null;
  } catch {
    return null;
  }
}

function pct(value: number) {
  return `${(value * 100).toFixed(2)}%`;
}

function num(value: number) {
  return Number.isFinite(value) ? value.toFixed(2) : "--";
}

function fmtTime(ts: number | null | undefined) {
  if (!ts) return "--";
  return new Date(ts * 1000).toLocaleString("zh-CN", { hour12: false });
}

function MetricCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div style={{ backgroundColor: "rgba(255,255,255,0.03)", border: "1px solid var(--color-border)", borderRadius: "8px", padding: "12px" }}>
      <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", marginBottom: "6px" }}>{label}</div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: "18px", color: "var(--color-text-primary)", fontWeight: 600 }}>{value}</div>
      {hint && <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", marginTop: "6px" }}>{hint}</div>}
    </div>
  );
}

function ParamInput({ label, value, onChange, min, max, step }: {
  label: string; value: number; onChange: (v: number) => void; min: number; max: number; step: number;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: "4px", color: "var(--color-text-secondary)", fontSize: "11px" }}>
      <span>{label}</span>
      <input type="number" value={value} onChange={(e) => onChange(Number(e.target.value))} min={min} max={max} step={step} style={{ width: "100%", boxSizing: "border-box" }} />
    </label>
  );
}

function reasonText(reason: string) {
  const map: Record<string, string> = {
    stop_loss: "固定止损",
    take_profit: "固定止盈",
    trailing_stop: "ATR追踪止损",
    reverse: "反向信号",
    time_exit: "持仓超时",
  };
  return map[reason] ?? reason;
}

function directionText(direction: TradeDirection) {
  const map: Record<TradeDirection, string> = {
    both: "双向",
    long_only: "只做多",
    short_only: "只做空",
  };
  return map[direction];
}

function MetricsGrid({ metrics, exitReasons }: { metrics: BacktestMetrics; exitReasons?: Record<string, number> }) {
  const reasonSummary = exitReasons && Object.keys(exitReasons).length
    ? Object.entries(exitReasons).map(([key, value]) => `${reasonText(key)} ${value}`).join(" / ")
    : "--";
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(120px, 1fr))", gap: "10px" }}>
      <MetricCard label="K线数量" value={String(metrics.candles)} />
      <MetricCard label="信号交易数" value={String(metrics.trades)} />
      <MetricCard label="胜率" value={pct(metrics.winRate)} />
      <MetricCard label="累计收益" value={pct(metrics.totalReturn)} />
      <MetricCard label="平均单次" value={pct(metrics.averageReturn)} />
      <MetricCard label="收益因子" value={num(metrics.profitFactor)} />
      <MetricCard label="最大回撤" value={pct(metrics.maxDrawdown)} />
      <MetricCard label="最大连亏" value={String(metrics.maxConsecutiveLosses)} />
      <div style={{ gridColumn: "1 / -1" }}>
        <MetricCard label="退出原因统计" value={reasonSummary} hint="含手续费、滑点、冷却期与 ATR 追踪止损后的交易结果" />
      </div>
    </div>
  );
}

interface PeriodComparisonRow {
  interval: string;
  real: BacktestResult | null;
  ideal: BacktestResult | null;
  error?: string;
}

interface DirectionStabilityRow {
  windowDays: number;
  direction: TradeDirection;
  result: BacktestResult | null;
  error?: string;
}

interface HigherTimeframeWindowRow {
  windowDays: number;
  baseline: BacktestResult | null;
  filtered: BacktestResult | null;
  error?: string;
}

interface ConservativeValidationRow {
  mode: "normal" | "conservative";
  label: string;
  signalDelayBars: number;
  conservativeSameBarExit: boolean;
  result: BacktestResult | null;
  error?: string;
}

function resultDiagnosis(metrics: BacktestMetrics | undefined | null) {
  if (!metrics) return "无数据";
  if (metrics.trades < 8) return "交易太少";
  if (metrics.totalReturn > 0 && metrics.profitFactor > 1.2) return "方向稳定有效";
  if (metrics.totalReturn > 0 && metrics.profitFactor > 1) return "弱正期望";
  if (metrics.profitFactor < 1 || metrics.totalReturn <= 0) return "方向拖累";
  return "需更多样本";
}

function PeriodComparison({ rows, loading, onRun }: { rows: PeriodComparisonRow[]; loading: boolean; onRun: () => void }) {
  const best = rows
    .filter((row) => row.real)
    .sort((a, b) => (b.real!.split.test.metrics.profitFactor - a.real!.split.test.metrics.profitFactor))[0];

  return (
    <section style={{ backgroundColor: "var(--color-bg-card)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
        <div>
          <div style={{ fontSize: "13px", color: "var(--color-text-primary)", fontWeight: 600 }}>周期对比</div>
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "4px" }}>一次性对比 15m / 1h / 4h 的理想与真实测试段表现，优先看真实收益因子和最大回撤。</div>
        </div>
        <button onClick={onRun} disabled={loading} style={{ padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--color-border)", background: loading ? "rgba(26,115,232,0.14)" : "var(--color-bg-elevated)", color: loading ? "var(--color-btn-primary)" : "var(--color-text-primary)", cursor: loading ? "default" : "pointer" }}>
          {loading ? "对比中..." : "运行周期对比"}
        </button>
      </div>
      {best?.real && <div style={{ marginBottom: "10px", color: "var(--color-long)", fontSize: "12px" }}>当前最优真实收益因子周期：{best.interval}，PF {num(best.real.split.test.metrics.profitFactor)}，真实收益 {pct(best.real.split.test.metrics.totalReturn)}</div>}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", color: "var(--color-text-secondary)" }}>
          <thead>
            <tr style={{ color: "var(--color-text-primary)", textAlign: "left" }}>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>周期</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>理想收益</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>真实收益</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>胜率</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>收益因子</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>最大回撤</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>交易数</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>诊断</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={8} style={{ padding: "12px", textAlign: "center", color: "var(--color-text-secondary)" }}>点击“运行周期对比”开始验证。</td></tr>
            )}
            {rows.map((row) => {
              const metrics = row.real?.split.test.metrics;
              const idealMetrics = row.ideal?.split.test.metrics;
              const diagnosis = row.error
                ? row.error
                : !metrics
                  ? "无数据"
                  : metrics.profitFactor > 1 && metrics.totalReturn > 0
                    ? "真实正期望"
                    : idealMetrics && idealMetrics.totalReturn > 0 && metrics.totalReturn <= 0
                      ? "摩擦/风控吞噬"
                      : "当前无正期望";
              return (
                <tr key={row.interval}>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: "var(--color-text-primary)", fontWeight: 600 }}>{row.interval}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: idealMetrics && idealMetrics.totalReturn >= 0 ? "var(--color-long)" : "var(--color-short)" }}>{idealMetrics ? pct(idealMetrics.totalReturn) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: metrics && metrics.totalReturn >= 0 ? "var(--color-long)" : "var(--color-short)" }}>{metrics ? pct(metrics.totalReturn) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{metrics ? pct(metrics.winRate) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: metrics && metrics.profitFactor >= 1 ? "var(--color-long)" : "#ffaa00" }}>{metrics ? num(metrics.profitFactor) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{metrics ? pct(metrics.maxDrawdown) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{metrics ? String(metrics.trades) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{diagnosis}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DirectionStability({ rows, loading, progress, onRun }: { rows: DirectionStabilityRow[]; loading: boolean; progress: string | null; onRun: () => void }) {
  const longWins = rows.filter((row) => row.direction === "long_only" && row.result && row.result.split.test.metrics.totalReturn > 0 && row.result.split.test.metrics.profitFactor > 1).length;
  const shortWins = rows.filter((row) => row.direction === "short_only" && row.result && row.result.split.test.metrics.totalReturn > 0 && row.result.split.test.metrics.profitFactor > 1).length;
  const summary = rows.length ? `方向稳定性：只做多通过 ${longWins} 个窗口，只做空通过 ${shortWins} 个窗口。` : "";

  return (
    <section style={{ backgroundColor: "var(--color-bg-card)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
        <div>
          <div style={{ fontSize: "13px", color: "var(--color-text-primary)", fontWeight: 600 }}>方向稳定性分窗验证</div>
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "4px" }}>固定 ETH_USDT / 1h / 双均线，分别用最近 90 / 180 / 270 / 360 天验证双向、只做多、只做空，避免被单一窗口误导。</div>
        </div>
        <button onClick={onRun} disabled={loading} style={{ padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--color-border)", background: loading ? "rgba(26,115,232,0.14)" : "var(--color-bg-elevated)", color: loading ? "var(--color-btn-primary)" : "var(--color-text-primary)", cursor: loading ? "default" : "pointer" }}>
          {loading ? "验证中..." : "运行方向稳定性验证"}
        </button>
      </div>
      {summary && <div style={{ marginBottom: "10px", color: longWins >= shortWins ? "var(--color-long)" : "#ffaa00", fontSize: "12px" }}>{summary}</div>}
      {progress && <div style={{ marginBottom: "10px", color: loading ? "var(--color-btn-primary)" : "var(--color-text-secondary)", fontSize: "12px" }}>{progress}</div>}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", color: "var(--color-text-secondary)" }}>
          <thead>
            <tr style={{ color: "var(--color-text-primary)", textAlign: "left" }}>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>窗口</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>方向</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>收益</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>胜率</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>PF</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>最大回撤</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>交易数</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>诊断</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={8} style={{ padding: "12px", textAlign: "center", color: "var(--color-text-secondary)" }}>点击“运行方向稳定性验证”开始分窗对比。</td></tr>}
            {rows.map((row) => {
              const metrics = row.result?.split.test.metrics;
              const diagnosis = row.error ?? resultDiagnosis(metrics);
              return (
                <tr key={`${row.windowDays}-${row.direction}`}>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: "var(--color-text-primary)", fontWeight: 600 }}>{row.windowDays}天</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: "var(--color-text-primary)", fontWeight: 600 }}>{directionText(row.direction)}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: metrics && metrics.totalReturn >= 0 ? "var(--color-long)" : "var(--color-short)" }}>{metrics ? pct(metrics.totalReturn) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{metrics ? pct(metrics.winRate) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: metrics && metrics.profitFactor >= 1 ? "var(--color-long)" : "#ffaa00" }}>{metrics ? num(metrics.profitFactor) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{metrics ? pct(metrics.maxDrawdown) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{metrics ? String(metrics.trades) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: diagnosis.includes("有效") || diagnosis.includes("正期望") ? "var(--color-long)" : "#ffaa00" }}>{diagnosis}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

interface OptimizationRow {
  minAdx: number;
  longRsiMax: number;
  shortRsiMin: number;
  atrTrailMultiplier: number;
  takeProfitAtrMultiplier: number;
  tradeDirection: TradeDirection;
  isCurrent?: boolean;
  rank?: number;
  real: BacktestResult | null;
  ideal: BacktestResult | null;
  score: number;
  tags: string[];
  robust: boolean;
  error?: string;
}

interface DualMaOptimizationRow {
  fastPeriod: number;
  slowPeriod: number;
  atrStopMultiplier: number;
  atrTrailMultiplier: number;
  takeProfitAtrMultiplier: number;
  isCurrent?: boolean;
  rank?: number;
  real: BacktestResult | null;
  ideal: BacktestResult | null;
  score: number;
  tags: string[];
  robust: boolean;
  error?: string;
}

interface HigherTimeframeOptimizationRow {
  higherTimeframe: HigherTimeframe;
  smaPeriod: number;
  requireSlope: boolean;
  isCurrent?: boolean;
  rank?: number;
  real: BacktestResult | null;
  ideal: BacktestResult | null;
  score: number;
  tags: string[];
  robust: boolean;
  error?: string;
}

interface LockedHigherTimeframeCandidate {
  exchange: string;
  strategy: "dual_ma";
  interval: "1h";
  tradeDirection: "both";
  fastPeriod: number;
  slowPeriod: number;
  rsiPeriod: number;
  longRsiMax: number;
  shortRsiMin: number;
  adxPeriod: number;
  minAdx: number;
  atrPeriod: number;
  atrStopMultiplier: number;
  atrTrailMultiplier: number;
  takeProfitAtrMultiplier: number;
  useTrailingStop: boolean;
  feeRate: number;
  slippageRate: number;
  cooldownBars: number;
  maxHoldBars: number;
  signalDelayBars: number;
  conservativeSameBarExit: boolean;
  useHigherTimeframeFilter: true;
  higherTimeframe: HigherTimeframe;
  higherTimeframeSmaPeriod: number;
  requireHigherTimeframeSlope: boolean;
  source?: {
    totalReturn: number;
    profitFactor: number;
    maxDrawdown: number;
    trades: number;
  };
}

function lockedCandidateLabel(candidate: LockedHigherTimeframeCandidate | null) {
  if (!candidate) return null;
  return `双均线 / ${candidate.interval} / 双向 / 快${candidate.fastPeriod} 慢${candidate.slowPeriod} / ${candidate.higherTimeframe} SMA${candidate.higherTimeframeSmaPeriod} / ${candidate.requireHigherTimeframeSlope ? "斜率确认" : "仅位置"}`;
}

function scoreOptimization(real: BacktestResult | null) {
  if (!real) return Number.NEGATIVE_INFINITY;
  const metrics = real.split.test.metrics;
  const boundedProfitFactor = Number.isFinite(metrics.profitFactor) ? Math.min(metrics.profitFactor, 3) : 3;
  return boundedProfitFactor * 40 + metrics.totalReturn * 100 - Math.abs(metrics.maxDrawdown) * 50 + metrics.winRate * 10;
}

function diagnoseOptimization(real: BacktestResult | null, ideal: BacktestResult | null) {
  if (!real) return { robust: false, tags: ["本地样本不足"] };
  const train = real.split.train.metrics;
  const test = real.split.test.metrics;
  const idealTest = ideal?.split.test.metrics;
  const tags: string[] = [];
  const drawdownOk = test.maxDrawdown >= -0.1;
  const enoughTrades = test.trades >= 8;
  const positiveExpectancy = test.profitFactor > 1 && test.totalReturn > 0;
  const trainTestSameDirection = train.totalReturn > 0 && test.totalReturn > 0;
  const frictionGap = idealTest ? idealTest.totalReturn - test.totalReturn : 0;

  if (positiveExpectancy && enoughTrades && drawdownOk && trainTestSameDirection) tags.push("稳健候选");
  if (!enoughTrades) tags.push("交易太少");
  if (!positiveExpectancy) tags.push("测试段未正期望");
  if (!drawdownOk) tags.push("回撤偏高");
  if (!trainTestSameDirection) tags.push("训练/测试不一致");
  if (frictionGap > 0.08) tags.push("摩擦敏感");
  if (test.winRate >= 0.45 && positiveExpectancy) tags.push("胜率改善");

  return {
    robust: positiveExpectancy && enoughTrades && drawdownOk && trainTestSameDirection,
    tags,
  };
}

function DefaultBenchmark({ benchmark, best }: { benchmark: BacktestResult | null; best: OptimizationRow | null }) {
  const defaultMetrics = benchmark?.split.test.metrics;
  const bestMetrics = best?.real?.split.test.metrics;
  const beatDefault = !!defaultMetrics && !!bestMetrics && bestMetrics.totalReturn > defaultMetrics.totalReturn && bestMetrics.profitFactor >= defaultMetrics.profitFactor;

  return (
    <section style={{ backgroundColor: "var(--color-bg-card)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "16px" }}>
      <div style={{ fontSize: "13px", color: "var(--color-text-primary)", marginBottom: "6px", fontWeight: 600 }}>SMA+RSI 参数基准对照</div>
      <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginBottom: "12px" }}>本面板只对应下方固定 SMA+RSI 优化，不代表当前页面选择的双均线策略。</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(120px, 1fr))", gap: "10px" }}>
        <MetricCard label="SMA+RSI基准收益" value={defaultMetrics ? pct(defaultMetrics.totalReturn) : "--"} hint="SMA+RSI / 当前风控参数 / 真实模式" />
        <MetricCard label="基准胜率" value={defaultMetrics ? pct(defaultMetrics.winRate) : "--"} />
        <MetricCard label="基准PF" value={defaultMetrics ? num(defaultMetrics.profitFactor) : "--"} />
        <MetricCard label="基准最大回撤" value={defaultMetrics ? pct(defaultMetrics.maxDrawdown) : "--"} />
        <MetricCard label="优化是否超过基准" value={bestMetrics ? (beatDefault ? "是" : "否") : "--"} hint={bestMetrics ? `SMA+RSI第一名收益 ${pct(bestMetrics.totalReturn)} / PF ${num(bestMetrics.profitFactor)}` : "先运行SMA+RSI优化"} />
      </div>
      {bestMetrics && !beatDefault && <div style={{ marginTop: "10px", color: "#ffaa00", fontSize: "12px" }}>当前 SMA+RSI 优化第一名没有同时超过基准收益和 PF，暂不建议替换为这组参数。</div>}
    </section>
  );
}

function DirectionBreakdownTable({ breakdown }: { breakdown?: DirectionBreakdown }) {
  const rows = [
    { label: "做多", metrics: breakdown?.long },
    { label: "做空", metrics: breakdown?.short },
  ];

  return (
    <section style={{ backgroundColor: "var(--color-bg-card)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "16px" }}>
      <div style={{ fontSize: "13px", color: "var(--color-text-primary)", marginBottom: "12px", fontWeight: 600 }}>多空拆分诊断</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", color: "var(--color-text-secondary)" }}>
          <thead>
            <tr style={{ color: "var(--color-text-primary)", textAlign: "left" }}>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>方向</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>交易数</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>收益</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>胜率</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>PF</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>平均单次</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>诊断</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const metrics = row.metrics;
              const diagnosis = !metrics || metrics.trades === 0
                ? "无交易"
                : metrics.profitFactor > 1 && metrics.totalReturn > 0
                  ? "方向有效"
                  : "方向拖累";
              return (
                <tr key={row.label}>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: "var(--color-text-primary)", fontWeight: 600 }}>{row.label}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{metrics ? String(metrics.trades) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: metrics && metrics.totalReturn >= 0 ? "var(--color-long)" : "var(--color-short)" }}>{metrics ? pct(metrics.totalReturn) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{metrics ? pct(metrics.winRate) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: metrics && metrics.profitFactor >= 1 ? "var(--color-long)" : "#ffaa00" }}>{metrics ? num(metrics.profitFactor) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{metrics ? pct(metrics.averageReturn) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: diagnosis === "方向有效" ? "var(--color-long)" : "#ffaa00" }}>{diagnosis}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function WalkForwardTable({ rows }: { rows?: BacktestResult["walkForward"] }) {
  return (
    <section style={{ backgroundColor: "var(--color-bg-card)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "16px" }}>
      <div style={{ fontSize: "13px", color: "var(--color-text-primary)", marginBottom: "12px", fontWeight: 600 }}>Walk-forward 滚动样本外验证</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", color: "var(--color-text-secondary)" }}>
          <thead>
            <tr style={{ color: "var(--color-text-primary)", textAlign: "left" }}>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>窗口</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>测试收益</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>PF</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>胜率</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>最大回撤</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>交易数</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>是否通过</th>
            </tr>
          </thead>
          <tbody>
            {(!rows || rows.length === 0) && <tr><td colSpan={7} style={{ padding: "12px", textAlign: "center" }}>暂无滚动验证数据</td></tr>}
            {rows?.map((row) => {
              const metrics = row.result.metrics;
              return (
                <tr key={row.label}>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: "var(--color-text-primary)", fontWeight: 600 }}>{row.label}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: metrics.totalReturn >= 0 ? "var(--color-long)" : "var(--color-short)" }}>{pct(metrics.totalReturn)}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: metrics.profitFactor >= 1 ? "var(--color-long)" : "#ffaa00" }}>{num(metrics.profitFactor)}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{pct(metrics.winRate)}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{pct(metrics.maxDrawdown)}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{metrics.trades}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: row.passed ? "var(--color-long)" : "#ffaa00" }}>{row.passed ? "通过" : "未通过"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ParameterOptimization({ rows, loading, progress, currentRank, activeStrategy, onRun }: { rows: OptimizationRow[]; loading: boolean; progress: string | null; currentRank: number | null; activeStrategy: string; onRun: () => void }) {
  const best = rows[0];

  return (
    <section style={{ backgroundColor: "var(--color-bg-card)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
        <div>
          <div style={{ fontSize: "13px", color: "var(--color-text-primary)", fontWeight: 600 }}>SMA+RSI 1h 参数优化</div>
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "4px" }}>固定 ETH_USDT / 1h / SMA+RSI，扫描 ADX、RSI 阈值、ATR追踪倍数、ATR止盈和交易方向；该结果与当前页面双均线回测分开解读。</div>
        </div>
        <button onClick={onRun} disabled={loading} style={{ padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--color-border)", background: loading ? "rgba(26,115,232,0.14)" : "var(--color-bg-elevated)", color: loading ? "var(--color-btn-primary)" : "var(--color-text-primary)", cursor: loading ? "default" : "pointer" }}>
          {loading ? "优化中..." : "运行1h参数优化"}
        </button>
      </div>
      {progress && <div style={{ marginBottom: "10px", color: loading ? "var(--color-btn-primary)" : "var(--color-text-secondary)", fontSize: "12px" }}>{progress}</div>}
      {activeStrategy !== "sma_rsi_pullback" && <div style={{ marginBottom: "10px", color: "#ffaa00", fontSize: "12px" }}>当前页面选择的是双均线，SMA+RSI 当前参数排名不适用；请看下方“双均线只做空专项优化”。</div>}
      {activeStrategy === "sma_rsi_pullback" && currentRank !== null && <div style={{ marginBottom: "10px", color: "var(--color-btn-primary)", fontSize: "12px" }}>当前页面 SMA+RSI 参数在本轮候选中的排名：#{currentRank}。</div>}
      {best?.real && <div style={{ marginBottom: "10px", color: best.robust ? "var(--color-long)" : "#ffaa00", fontSize: "12px" }}>当前排名第一：{directionText(best.tradeDirection)}，ADX≥{best.minAdx}，多RSI≤{best.longRsiMax}，空RSI≥{best.shortRsiMin}，ATR追踪×{best.atrTrailMultiplier}，ATR止盈×{best.takeProfitAtrMultiplier}；真实收益 {pct(best.real.split.test.metrics.totalReturn)}，PF {num(best.real.split.test.metrics.profitFactor)}，{best.tags.join(" / ")}</div>}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", color: "var(--color-text-secondary)" }}>
          <thead>
            <tr style={{ color: "var(--color-text-primary)", textAlign: "left" }}>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>排名</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>方向</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>参数组合</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>真实收益</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>胜率</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>PF</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>最大回撤</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>交易数</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>理想收益</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>理想/真实差值</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>标签</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={11} style={{ padding: "12px", textAlign: "center", color: "var(--color-text-secondary)" }}>点击“运行1h参数优化”开始扫描。建议先确保 OKX 已补充至少 180 天 1h 数据。</td></tr>
            )}
            {rows.map((row, index) => {
              const real = row.real?.split.test.metrics;
              const ideal = row.ideal?.split.test.metrics;
              const gap = real && ideal ? ideal.totalReturn - real.totalReturn : null;
              return (
                <tr key={`${row.tradeDirection}-${row.minAdx}-${row.longRsiMax}-${row.shortRsiMin}-${row.atrTrailMultiplier}-${row.takeProfitAtrMultiplier}`}>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: row.robust ? "var(--color-long)" : "var(--color-text-primary)", fontWeight: 600 }}>#{row.rank ?? index + 1}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: "var(--color-text-primary)", fontWeight: 600 }}>{directionText(row.tradeDirection)}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", fontFamily: "var(--font-mono)", color: row.isCurrent ? "var(--color-btn-primary)" : "var(--color-text-primary)" }}>ADX≥{row.minAdx} / 多≤{row.longRsiMax} / 空≥{row.shortRsiMin} / ATR追踪×{row.atrTrailMultiplier} / ATR止盈×{row.takeProfitAtrMultiplier}{row.isCurrent ? " / 当前" : ""}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: real && real.totalReturn >= 0 ? "var(--color-long)" : "var(--color-short)" }}>{real ? pct(real.totalReturn) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{real ? pct(real.winRate) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: real && real.profitFactor >= 1 ? "var(--color-long)" : "#ffaa00" }}>{real ? num(real.profitFactor) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{real ? pct(real.maxDrawdown) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{real ? String(real.trades) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: ideal && ideal.totalReturn >= 0 ? "var(--color-long)" : "var(--color-short)" }}>{ideal ? pct(ideal.totalReturn) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{gap === null ? "--" : pct(gap)}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: row.robust ? "var(--color-long)" : "#ffaa00" }}>{row.tags.join(" / ") || row.error || "--"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ConservativeValidation({ rows, loading, progress, lockedCandidate, onRun }: { rows: ConservativeValidationRow[]; loading: boolean; progress: string | null; lockedCandidate: LockedHigherTimeframeCandidate | null; onRun: () => void }) {
  const normal = rows.find((row) => row.mode === "normal")?.result?.split.test.metrics;
  const conservative = rows.find((row) => row.mode === "conservative")?.result?.split.test.metrics;
  const passed = !!conservative && conservative.totalReturn > 0.05 && conservative.profitFactor > 1.2 && conservative.maxDrawdown > -0.08 && conservative.trades >= 10;
  const candidateLabel = lockedCandidateLabel(lockedCandidate);

  return (
    <section style={{ backgroundColor: "var(--color-bg-card)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
        <div>
          <div style={{ fontSize: "13px", color: "var(--color-text-primary)", fontWeight: 600 }}>当前主候选保守回测验证</div>
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "4px" }}>固定“已锁定候选”参数，对比普通模式与信号延迟 1 根 K 线、同 K 线冲突优先止损的保守模式，避免与当前页面参数混用。</div>
        </div>
        <button onClick={onRun} disabled={loading} style={{ padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--color-border)", background: loading ? "rgba(26,115,232,0.14)" : "var(--color-bg-elevated)", color: loading ? "var(--color-btn-primary)" : "var(--color-text-primary)", cursor: loading ? "default" : "pointer" }}>
          {loading ? "验证中..." : "运行保守回测对照"}
        </button>
      </div>
      {candidateLabel && <div style={{ marginBottom: "10px", color: "var(--color-btn-primary)", fontSize: "12px" }}>锁定候选：{candidateLabel}</div>}
      {!candidateLabel && <div style={{ marginBottom: "10px", color: "#ffaa00", fontSize: "12px" }}>尚未锁定候选。请先在“高周期过滤参数优化”中点击“一键应用当前第一名并锁定”。</div>}
      {normal && conservative && <div style={{ marginBottom: "10px", color: passed ? "var(--color-long)" : "#ffaa00", fontSize: "12px" }}>{passed ? "保守模式通过：收益、PF、回撤和交易数仍满足当前研究阈值。" : "保守模式未完全通过：需重点检查收益、PF、回撤或交易数是否被执行假设削弱。"}</div>}
      {progress && <div style={{ marginBottom: "10px", color: loading ? "var(--color-btn-primary)" : "var(--color-text-secondary)", fontSize: "12px" }}>{progress}</div>}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", color: "var(--color-text-secondary)" }}>
          <thead>
            <tr style={{ color: "var(--color-text-primary)", textAlign: "left" }}>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>模式</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>信号延迟</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>同K线冲突</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>收益</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>胜率</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>PF</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>最大回撤</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>交易数</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>多空拆分</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>诊断</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={10} style={{ padding: "12px", textAlign: "center", color: "var(--color-text-secondary)" }}>点击“运行保守回测对照”开始验证当前主候选。</td></tr>}
            {rows.map((row) => {
              const metrics = row.result?.split.test.metrics;
              const breakdown = row.result?.split.test.directionBreakdown;
              const diagnosis = row.error
                ? row.error
                : !metrics
                  ? "无数据"
                  : row.mode === "conservative" && metrics.totalReturn > 0.05 && metrics.profitFactor > 1.2 && metrics.maxDrawdown > -0.08 && metrics.trades >= 10
                    ? "保守通过"
                    : metrics.totalReturn > 0 && metrics.profitFactor > 1
                      ? "正期望"
                      : "未通过";
              return (
                <tr key={row.mode}>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: "var(--color-text-primary)", fontWeight: 600 }}>{row.label}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{row.signalDelayBars}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{row.conservativeSameBarExit ? "优先止损" : "普通"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: metrics && metrics.totalReturn >= 0 ? "var(--color-long)" : "var(--color-short)" }}>{metrics ? pct(metrics.totalReturn) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{metrics ? pct(metrics.winRate) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: metrics && metrics.profitFactor >= 1 ? "var(--color-long)" : "#ffaa00" }}>{metrics ? num(metrics.profitFactor) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{metrics ? pct(metrics.maxDrawdown) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{metrics ? String(metrics.trades) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", fontFamily: "var(--font-mono)" }}>{breakdown ? `多 ${pct(breakdown.long.totalReturn)} / 空 ${pct(breakdown.short.totalReturn)}` : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: diagnosis.includes("通过") || diagnosis.includes("正期望") ? "var(--color-long)" : "#ffaa00" }}>{diagnosis}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function HigherTimeframeWindowValidation({ rows, loading, progress, lockedCandidate, onRun }: { rows: HigherTimeframeWindowRow[]; loading: boolean; progress: string | null; lockedCandidate: LockedHigherTimeframeCandidate | null; onRun: () => void }) {
  const improved = rows.filter((row) => {
    const baseline = row.baseline?.split.test.metrics;
    const filtered = row.filtered?.split.test.metrics;
    return baseline && filtered && filtered.totalReturn > baseline.totalReturn && filtered.profitFactor >= baseline.profitFactor;
  }).length;
  const summary = rows.length ? `高周期过滤在 ${improved} / ${rows.length} 个窗口中同时改善收益与 PF。` : "";
  const candidateLabel = lockedCandidateLabel(lockedCandidate);

  return (
    <section style={{ backgroundColor: "var(--color-bg-card)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
        <div>
          <div style={{ fontSize: "13px", color: "var(--color-text-primary)", fontWeight: 600 }}>高周期过滤分窗稳定性验证</div>
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "4px" }}>用“已锁定候选”参数，对比最近 90 / 180 / 270 / 360 天的默认双向与过滤后表现，验证候选过滤器是否跨窗口稳定。</div>
        </div>
        <button onClick={onRun} disabled={loading} style={{ padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--color-border)", background: loading ? "rgba(26,115,232,0.14)" : "var(--color-bg-elevated)", color: loading ? "var(--color-btn-primary)" : "var(--color-text-primary)", cursor: loading ? "default" : "pointer" }}>
          {loading ? "验证中..." : "运行高周期分窗验证"}
        </button>
      </div>
      {candidateLabel && <div style={{ marginBottom: "10px", color: "var(--color-btn-primary)", fontSize: "12px" }}>锁定候选：{candidateLabel}</div>}
      {!candidateLabel && <div style={{ marginBottom: "10px", color: "#ffaa00", fontSize: "12px" }}>尚未锁定候选。请先在“高周期过滤参数优化”中点击“一键应用当前第一名并锁定”。</div>}
      {summary && <div style={{ marginBottom: "10px", color: improved >= Math.ceil(rows.length / 2) ? "var(--color-long)" : "#ffaa00", fontSize: "12px" }}>{summary}</div>}
      {progress && <div style={{ marginBottom: "10px", color: loading ? "var(--color-btn-primary)" : "var(--color-text-secondary)", fontSize: "12px" }}>{progress}</div>}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", color: "var(--color-text-secondary)" }}>
          <thead>
            <tr style={{ color: "var(--color-text-primary)", textAlign: "left" }}>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>窗口</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>默认收益</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>过滤收益</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>收益改善</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>默认PF</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>过滤PF</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>默认回撤</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>过滤回撤</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>过滤交易数</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>诊断</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={10} style={{ padding: "12px", textAlign: "center", color: "var(--color-text-secondary)" }}>点击“运行高周期分窗验证”开始对比当前过滤器。</td></tr>}
            {rows.map((row) => {
              const baseline = row.baseline?.split.test.metrics;
              const filtered = row.filtered?.split.test.metrics;
              const improvement = baseline && filtered ? filtered.totalReturn - baseline.totalReturn : null;
              const diagnosis = row.error
                ? row.error
                : baseline && filtered && filtered.totalReturn > baseline.totalReturn && filtered.profitFactor >= baseline.profitFactor
                  ? "收益/PF改善"
                  : filtered && filtered.totalReturn > 0 && filtered.profitFactor > 1
                    ? "过滤后正期望"
                    : "未改善";
              return (
                <tr key={row.windowDays}>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: "var(--color-text-primary)", fontWeight: 600 }}>{row.windowDays}天</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: baseline && baseline.totalReturn >= 0 ? "var(--color-long)" : "var(--color-short)" }}>{baseline ? pct(baseline.totalReturn) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: filtered && filtered.totalReturn >= 0 ? "var(--color-long)" : "var(--color-short)" }}>{filtered ? pct(filtered.totalReturn) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: improvement !== null && improvement >= 0 ? "var(--color-long)" : "var(--color-short)" }}>{improvement === null ? "--" : pct(improvement)}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{baseline ? num(baseline.profitFactor) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: filtered && filtered.profitFactor >= 1 ? "var(--color-long)" : "#ffaa00" }}>{filtered ? num(filtered.profitFactor) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{baseline ? pct(baseline.maxDrawdown) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{filtered ? pct(filtered.maxDrawdown) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{filtered ? String(filtered.trades) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: diagnosis.includes("改善") || diagnosis.includes("正期望") ? "var(--color-long)" : "#ffaa00" }}>{diagnosis}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function HigherTimeframeOptimization({ rows, loading, progress, currentRank, onRun, onApply }: { rows: HigherTimeframeOptimizationRow[]; loading: boolean; progress: string | null; currentRank: number | null; onRun: () => void; onApply: (row: HigherTimeframeOptimizationRow) => void }) {
  const best = rows[0];
  const bestMetrics = best?.real?.split.test.metrics;

  return (
    <section style={{ backgroundColor: "var(--color-bg-card)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
        <div>
          <div style={{ fontSize: "13px", color: "var(--color-text-primary)", fontWeight: 600 }}>高周期过滤参数优化</div>
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "4px" }}>固定 ETH_USDT / 1h / 双均线 / 双向，扫描 4h/1d、SMA周期和是否要求斜率，用于自动寻找动态多空方向过滤组合。</div>
        </div>
        <button onClick={onRun} disabled={loading} style={{ padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--color-border)", background: loading ? "rgba(26,115,232,0.14)" : "var(--color-bg-elevated)", color: loading ? "var(--color-btn-primary)" : "var(--color-text-primary)", cursor: loading ? "default" : "pointer" }}>
          {loading ? "优化中..." : "运行高周期过滤优化"}
        </button>
      </div>
      {progress && <div style={{ marginBottom: "10px", color: loading ? "var(--color-btn-primary)" : "var(--color-text-secondary)", fontSize: "12px" }}>{progress}</div>}
      {currentRank !== null && <div style={{ marginBottom: "10px", color: "var(--color-btn-primary)", fontSize: "12px" }}>当前页面高周期过滤参数在本轮候选中的排名：#{currentRank}。</div>}
      {bestMetrics && <div style={{ marginBottom: "10px", color: best?.robust ? "var(--color-long)" : "#ffaa00", fontSize: "12px" }}>当前排名第一：{best.higherTimeframe} / SMA{best.smaPeriod} / {best.requireSlope ? "要求斜率" : "不要求斜率"}；真实收益 {pct(bestMetrics.totalReturn)}，PF {num(bestMetrics.profitFactor)}，{best.tags.join(" / ")}</div>}
      {best && <button onClick={() => onApply(best)} style={{ marginBottom: "10px", padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--color-border)", background: "rgba(26,115,232,0.14)", color: "var(--color-btn-primary)", cursor: "pointer" }}>一键应用当前第一名并锁定</button>}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", color: "var(--color-text-secondary)" }}>
          <thead>
            <tr style={{ color: "var(--color-text-primary)", textAlign: "left" }}>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>排名</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>参数组合</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>真实收益</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>胜率</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>PF</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>最大回撤</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>交易数</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>理想收益</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>多空拆分</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>标签</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={10} style={{ padding: "12px", textAlign: "center", color: "var(--color-text-secondary)" }}>点击“运行高周期过滤优化”开始扫描 20 组动态方向过滤参数。</td></tr>}
            {rows.map((row, index) => {
              const real = row.real?.split.test.metrics;
              const ideal = row.ideal?.split.test.metrics;
              const breakdown = row.real?.split.test.directionBreakdown;
              return (
                <tr key={`${row.higherTimeframe}-${row.smaPeriod}-${row.requireSlope}`}>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: row.robust ? "var(--color-long)" : "var(--color-text-primary)", fontWeight: 600 }}>#{row.rank ?? index + 1}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", fontFamily: "var(--font-mono)", color: row.isCurrent ? "var(--color-btn-primary)" : "var(--color-text-primary)" }}>{row.higherTimeframe} / SMA{row.smaPeriod} / {row.requireSlope ? "斜率确认" : "仅位置"}{row.isCurrent ? " / 当前" : ""}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: real && real.totalReturn >= 0 ? "var(--color-long)" : "var(--color-short)" }}>{real ? pct(real.totalReturn) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{real ? pct(real.winRate) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: real && real.profitFactor >= 1 ? "var(--color-long)" : "#ffaa00" }}>{real ? num(real.profitFactor) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{real ? pct(real.maxDrawdown) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{real ? String(real.trades) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: ideal && ideal.totalReturn >= 0 ? "var(--color-long)" : "var(--color-short)" }}>{ideal ? pct(ideal.totalReturn) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", fontFamily: "var(--font-mono)" }}>{breakdown ? `多 ${pct(breakdown.long.totalReturn)} / 空 ${pct(breakdown.short.totalReturn)}` : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: row.robust ? "var(--color-long)" : "#ffaa00" }}>{row.tags.join(" / ") || row.error || "--"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DualMaDirectionalOptimization({ title, description, emptyText, runButtonText, rows, benchmark, loading, progress, currentRank, direction, onRun, onApply }: { title: string; description: string; emptyText: string; runButtonText: string; rows: DualMaOptimizationRow[]; benchmark: BacktestResult | null; loading: boolean; progress: string | null; currentRank: number | null; direction: TradeDirection; onRun: () => void; onApply: (row: DualMaOptimizationRow, direction: TradeDirection) => void }) {
  const best = rows[0];
  const benchmarkMetrics = benchmark?.split.test.metrics;
  const bestMetrics = best?.real?.split.test.metrics;
  const beatBenchmark = !!benchmarkMetrics && !!bestMetrics && bestMetrics.totalReturn > benchmarkMetrics.totalReturn && bestMetrics.profitFactor >= benchmarkMetrics.profitFactor;

  return (
    <section style={{ backgroundColor: "var(--color-bg-card)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
        <div>
          <div style={{ fontSize: "13px", color: "var(--color-text-primary)", fontWeight: 600 }}>{title}</div>
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "4px" }}>{description}</div>
        </div>
        <button onClick={onRun} disabled={loading} style={{ padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--color-border)", background: loading ? "rgba(26,115,232,0.14)" : "var(--color-bg-elevated)", color: loading ? "var(--color-btn-primary)" : "var(--color-text-primary)", cursor: loading ? "default" : "pointer" }}>
          {loading ? "优化中..." : runButtonText}
        </button>
      </div>
      {benchmarkMetrics && <div style={{ marginBottom: "10px", color: "var(--color-text-secondary)", fontSize: "12px" }}>当前双均线{directionText(direction)}基准：收益 {pct(benchmarkMetrics.totalReturn)}，PF {num(benchmarkMetrics.profitFactor)}，胜率 {pct(benchmarkMetrics.winRate)}。</div>}
      {progress && <div style={{ marginBottom: "10px", color: loading ? "var(--color-btn-primary)" : "var(--color-text-secondary)", fontSize: "12px" }}>{progress}</div>}
      {currentRank !== null && <div style={{ marginBottom: "10px", color: "var(--color-btn-primary)", fontSize: "12px" }}>当前页面双均线只做空参数在本轮候选中的排名：#{currentRank}。</div>}
      {bestMetrics && <div style={{ marginBottom: "10px", color: best?.robust ? "var(--color-long)" : "#ffaa00", fontSize: "12px" }}>当前排名第一：快线 {best.fastPeriod} / 慢线 {best.slowPeriod} / ATR止损×{best.atrStopMultiplier} / ATR追踪×{best.atrTrailMultiplier} / ATR止盈×{best.takeProfitAtrMultiplier}；真实收益 {pct(bestMetrics.totalReturn)}，PF {num(bestMetrics.profitFactor)}，{best.tags.join(" / ")}</div>}
      {bestMetrics && benchmarkMetrics && <div style={{ marginBottom: "10px", color: beatBenchmark ? "var(--color-long)" : "#ffaa00", fontSize: "12px" }}>{beatBenchmark ? "优化第一名已同时超过当前基准收益和 PF。" : "优化第一名未同时超过当前基准收益和 PF，暂不建议直接替换。"}</div>}
      {best && <button onClick={() => onApply(best, direction)} style={{ marginBottom: "10px", padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--color-border)", background: "rgba(26,115,232,0.14)", color: "var(--color-btn-primary)", cursor: "pointer" }}>一键应用当前第一名并重新验证</button>}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", color: "var(--color-text-secondary)" }}>
          <thead>
            <tr style={{ color: "var(--color-text-primary)", textAlign: "left" }}>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>排名</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>参数组合</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>真实收益</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>胜率</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>PF</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>最大回撤</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>交易数</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>理想收益</th>
              <th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>标签</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={9} style={{ padding: "12px", textAlign: "center", color: "var(--color-text-secondary)" }}>{emptyText}</td></tr>}
            {rows.map((row, index) => {
              const real = row.real?.split.test.metrics;
              const ideal = row.ideal?.split.test.metrics;
              return (
                <tr key={`${row.fastPeriod}-${row.slowPeriod}-${row.atrStopMultiplier}-${row.atrTrailMultiplier}-${row.takeProfitAtrMultiplier}`}>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: row.robust ? "var(--color-long)" : "var(--color-text-primary)", fontWeight: 600 }}>#{row.rank ?? index + 1}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", fontFamily: "var(--font-mono)", color: row.isCurrent ? "var(--color-btn-primary)" : "var(--color-text-primary)" }}>快{row.fastPeriod} / 慢{row.slowPeriod} / 止损×{row.atrStopMultiplier} / 追踪×{row.atrTrailMultiplier} / 止盈×{row.takeProfitAtrMultiplier}{row.isCurrent ? " / 当前" : ""}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: real && real.totalReturn >= 0 ? "var(--color-long)" : "var(--color-short)" }}>{real ? pct(real.totalReturn) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{real ? pct(real.winRate) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: real && real.profitFactor >= 1 ? "var(--color-long)" : "#ffaa00" }}>{real ? num(real.profitFactor) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{real ? pct(real.maxDrawdown) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{real ? String(real.trades) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: ideal && ideal.totalReturn >= 0 ? "var(--color-long)" : "var(--color-short)" }}>{ideal ? pct(ideal.totalReturn) : "--"}</td>
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: row.robust ? "var(--color-long)" : "#ffaa00" }}>{row.tags.join(" / ") || row.error || "--"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function StrategyDiagnosis({ result, idealResult, interval }: { result: BacktestResult; idealResult: BacktestResult | null; interval: string }) {
  const real = result.split.test.metrics;
  const ideal = idealResult?.split.test.metrics;
  const exits = result.split.test.exitReasons ?? {};
  const totalExits = Object.values(exits).reduce((sum, value) => sum + value, 0);
  const trailingRatio = totalExits ? (exits.trailing_stop ?? 0) / totalExits : 0;
  const timeExitRatio = totalExits ? (exits.time_exit ?? 0) / totalExits : 0;
  const gap = ideal ? ideal.totalReturn - real.totalReturn : 0;
  const items: Array<{ level: "good" | "warn" | "bad"; text: string }> = [];

  if (ideal && ideal.totalReturn > 0 && real.totalReturn <= 0) {
    items.push({ level: "warn", text: "理想模式为正、真实模式为负：策略入场有一定有效性，但手续费、滑点或风控参数正在吞噬收益。" });
  } else if (ideal && ideal.totalReturn <= 0 && real.totalReturn <= 0) {
    items.push({ level: "bad", text: "理想和真实模式都为负：当前策略逻辑不适合这段样本，应换策略结构或换周期/标的。" });
  } else if (real.totalReturn > 0 && real.profitFactor > 1) {
    items.push({ level: "good", text: "真实测试段为正且收益因子大于 1：当前参数在样本外具备初步正期望，可继续做更长样本验证。" });
  }

  if (interval === "15m" && ideal && gap > 0.08) {
    items.push({ level: "warn", text: "15m 下理想/真实差值较大：短周期交易频率偏高，更容易被交易摩擦吃掉，建议优先验证 1h。" });
  }
  if (interval === "1h" && real.totalReturn > -0.05) {
    items.push({ level: "good", text: "1h 结果相对改善：说明策略更适合中周期，后续应围绕 1h 优先调参。" });
  }
  if (trailingRatio > 0.45) {
    items.push({ level: "warn", text: "ATR追踪止损占比偏高：可能过早下车，建议提高 ATR追踪倍数或临时关闭追踪止损对比。" });
  }
  if (timeExitRatio > 0.25) {
    items.push({ level: "warn", text: "持仓超时退出较多：最大持仓K线可能过短，建议调大或设为 0。" });
  }
  if (real.trades > 80 && interval === "15m") {
    items.push({ level: "warn", text: "测试段交易数偏多：建议提高周期、加严 RSI 回调条件，或提高最小ADX减少噪音交易。" });
  }
  if (real.profitFactor < 1) {
    items.push({ level: "bad", text: "真实收益因子低于 1：当前真实参数在测试段仍不是正期望，只适合继续研究，不适合当作可用信号。" });
  }
  if (!items.length) {
    items.push({ level: "warn", text: "样本信号不足或指标接近临界值，建议补充更长历史数据后再判断。" });
  }

  return (
    <section style={{ backgroundColor: "var(--color-bg-card)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "16px" }}>
      <div style={{ fontSize: "13px", color: "var(--color-text-primary)", marginBottom: "12px", fontWeight: 600 }}>策略诊断</div>
      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        {items.map((item, index) => (
          <div key={index} style={{ padding: "10px 12px", borderRadius: "8px", border: "1px solid var(--color-border)", backgroundColor: item.level === "good" ? "rgba(0,255,136,0.08)" : item.level === "bad" ? "rgba(255,77,79,0.08)" : "rgba(255,170,0,0.08)", color: item.level === "good" ? "var(--color-long)" : item.level === "bad" ? "#ff6b6b" : "#ffaa00", fontSize: "12px", lineHeight: 1.6 }}>
            {item.text}
          </div>
        ))}
      </div>
    </section>
  );
}

export default function BacktestView() {
  const { interval, historicalSource, setInterval: setMarketInterval } = useMarketStore();
  const { strategy, fastPeriod, slowPeriod, rsiPeriod, longRsiMax, shortRsiMin, adxPeriod, minAdx, atrPeriod, atrStopMultiplier, atrTrailMultiplier, takeProfitAtrMultiplier, useTrailingStop, feeRate, slippageRate, cooldownBars, maxHoldBars, tradeDirection, useHigherTimeframeFilter, higherTimeframe, higherTimeframeSmaPeriod, requireHigherTimeframeSlope, signalDelayBars, conservativeSameBarExit, setStrategy, setParams } = useStrategyStore();
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [idealResult, setIdealResult] = useState<BacktestResult | null>(null);
  const [range, setRange] = useState<CandleRange | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const [backfilling, setBackfilling] = useState(false);
  const [periodComparing, setPeriodComparing] = useState(false);
  const [periodRows, setPeriodRows] = useState<PeriodComparisonRow[]>([]);
  const [directionStabilityLoading, setDirectionStabilityLoading] = useState(false);
  const [directionStabilityRows, setDirectionStabilityRows] = useState<DirectionStabilityRow[]>([]);
  const [directionStabilityProgress, setDirectionStabilityProgress] = useState<string | null>(null);
  const [higherTimeframeOptimizing, setHigherTimeframeOptimizing] = useState(false);
  const [higherTimeframeRows, setHigherTimeframeRows] = useState<HigherTimeframeOptimizationRow[]>([]);
  const [higherTimeframeProgress, setHigherTimeframeProgress] = useState<string | null>(null);
  const [currentHigherTimeframeRank, setCurrentHigherTimeframeRank] = useState<number | null>(null);
  const [higherTimeframeWindowLoading, setHigherTimeframeWindowLoading] = useState(false);
  const [higherTimeframeWindowRows, setHigherTimeframeWindowRows] = useState<HigherTimeframeWindowRow[]>([]);
  const [higherTimeframeWindowProgress, setHigherTimeframeWindowProgress] = useState<string | null>(null);
  const [lockedHigherTimeframeCandidate, setLockedHigherTimeframeCandidate] = useState<LockedHigherTimeframeCandidate | null>(null);
  const [conservativeValidationLoading, setConservativeValidationLoading] = useState(false);
  const [conservativeValidationRows, setConservativeValidationRows] = useState<ConservativeValidationRow[]>([]);
  const [conservativeValidationProgress, setConservativeValidationProgress] = useState<string | null>(null);
  const [optimizing, setOptimizing] = useState(false);
  const [optimizationRows, setOptimizationRows] = useState<OptimizationRow[]>([]);
  const [optimizationBenchmark, setOptimizationBenchmark] = useState<BacktestResult | null>(null);
  const [optimizationProgress, setOptimizationProgress] = useState<string | null>(null);
  const [currentOptimizationRank, setCurrentOptimizationRank] = useState<number | null>(null);
  const [dualOptimizing, setDualOptimizing] = useState(false);
  const [dualOptimizationRows, setDualOptimizationRows] = useState<DualMaOptimizationRow[]>([]);
  const [dualOptimizationBenchmark, setDualOptimizationBenchmark] = useState<BacktestResult | null>(null);
  const [dualOptimizationProgress, setDualOptimizationProgress] = useState<string | null>(null);
  const [currentDualOptimizationRank, setCurrentDualOptimizationRank] = useState<number | null>(null);
  const [dualLongOptimizing, setDualLongOptimizing] = useState(false);
  const [dualLongOptimizationRows, setDualLongOptimizationRows] = useState<DualMaOptimizationRow[]>([]);
  const [dualLongOptimizationBenchmark, setDualLongOptimizationBenchmark] = useState<BacktestResult | null>(null);
  const [dualLongOptimizationProgress, setDualLongOptimizationProgress] = useState<string | null>(null);
  const [currentDualLongOptimizationRank, setCurrentDualLongOptimizationRank] = useState<number | null>(null);
  const [backfillMessage, setBackfillMessage] = useState<string | null>(null);
  const [backfillJob, setBackfillJob] = useState<BackfillJob | null>(null);
  const savedForm = loadBackfillForm();
  const [backfillDays, setBackfillDays] = useState(savedForm?.days ?? 30);
  const [backfillSymbols, setBackfillSymbols] = useState(savedForm?.symbols ?? "ETH_USDT,BTC_USDT");
  const [backfillIntervals, setBackfillIntervals] = useState(savedForm?.intervals ?? "15m,1h");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setValidationMessage("正在重新读取本地样本并执行回测...");
    try {
      const local = await getLocalCandles({ exchange: historicalSource, symbol: "ETH_USDT", interval, limit: 1 });
      setRange(local?.range ?? null);
      const backtestStrategy: "dual_ma" | "sma_rsi_pullback" = strategy === "sma_rsi_pullback" ? "sma_rsi_pullback" : "dual_ma";
      const commonParams = { exchange: historicalSource, symbol: "ETH_USDT", interval, strategy: backtestStrategy, fastPeriod, slowPeriod, rsiPeriod, longRsiMax, shortRsiMin, adxPeriod, minAdx, atrPeriod, atrStopMultiplier, atrTrailMultiplier, takeProfitAtrMultiplier, useTrailingStop, feeRate, slippageRate, cooldownBars, maxHoldBars, tradeDirection, useHigherTimeframeFilter, higherTimeframe, higherTimeframeSmaPeriod, requireHigherTimeframeSlope, signalDelayBars, conservativeSameBarExit };
      const [data, idealData] = await Promise.all([
        runBacktest(commonParams),
        runBacktest({ ...commonParams, minAdx: 0, useTrailingStop: false, feeRate: 0, slippageRate: 0, cooldownBars: 0, maxHoldBars: 0 }),
      ]);
      if (!data) {
        setResult(null);
        setIdealResult(null);
        setValidationMessage(null);
        setError(`本地历史数据不足或后端未启动。当前历史源：${historicalSource.toUpperCase()}。长历史建议选择 OKX 后点击“补充历史数据”，或运行 npm run backfill -- --exchange okx --symbols ETH_USDT,BTC_USDT --intervals 15m,1h --days 180`);
      } else {
        setResult(data);
        setIdealResult(idealData);
        const realReturn = data.split.test.metrics.totalReturn;
        const idealReturn = idealData?.split.test.metrics.totalReturn;
        const gapText = typeof idealReturn === "number" ? `理想/真实测试段差值 ${pct(idealReturn - realReturn)}。` : "";
        setValidationMessage(`验证完成：${data.exchange?.toUpperCase() ?? historicalSource.toUpperCase()} / ${data.symbol} / ${data.interval} / ${data.strategy === "sma_rsi_pullback" ? "SMA+RSI" : "双均线"}，训练段 ${data.split.train.metrics.candles} 根，测试段 ${data.split.test.metrics.candles} 根。${gapText}`);
      }
    } catch (err) {
      setResult(null);
      setIdealResult(null);
      setValidationMessage(null);
      setError(`重新验证失败：${err instanceof Error ? err.message : "未知错误"}`);
    } finally {
      setLoading(false);
    }
  }, [adxPeriod, atrPeriod, atrStopMultiplier, atrTrailMultiplier, cooldownBars, fastPeriod, feeRate, historicalSource, interval, longRsiMax, maxHoldBars, minAdx, rsiPeriod, shortRsiMin, slippageRate, slowPeriod, strategy, takeProfitAtrMultiplier, tradeDirection, useHigherTimeframeFilter, higherTimeframe, higherTimeframeSmaPeriod, requireHigherTimeframeSlope, signalDelayBars, conservativeSameBarExit, useTrailingStop]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    window.localStorage.setItem(BACKFILL_FORM_STORAGE_KEY, JSON.stringify({ days: backfillDays, symbols: backfillSymbols, intervals: backfillIntervals }));
  }, [backfillDays, backfillSymbols, backfillIntervals]);

  useEffect(() => {
    const jobId = loadBackfillJobId();
    if (!jobId || backfillJob) return;
    let cancelled = false;
    getBackfillJob(jobId).then((data) => {
      if (cancelled || !data?.job) return;
      setBackfillJob(data.job);
      setBackfilling(data.job.status === "running");
      setBackfillMessage(data.job.status === "running"
        ? `${data.job.exchange.toUpperCase()} 补数任务恢复中`
        : data.job.status === "completed"
          ? `${data.job.exchange.toUpperCase()} 已写入/更新 ${data.job.inserted} 根K线`
          : `补充历史数据失败：${data.job.error ?? "未知错误"}`);
    });
    return () => {
      cancelled = true;
    };
  }, [backfillJob]);

  useEffect(() => {
    if (!backfillJob || backfillJob.status !== "running") return;
    saveBackfillJob(backfillJob);
    const poll = async () => {
      const data = await getBackfillJob(backfillJob.id);
      if (!data?.job) return;
      setBackfillJob(data.job);
      if (data.job.status !== "running") {
        setBackfilling(false);
        setBackfillMessage(data.job.status === "completed"
          ? `${data.job.exchange.toUpperCase()} 已写入/更新 ${data.job.inserted} 根K线`
          : `补充历史数据失败：${data.job.error ?? "未知错误"}`);
        await load();
      }
    };
    void poll();
    const timer = window.setInterval(poll, 1200);
    return () => window.clearInterval(timer);
  }, [backfillJob, load]);

  const runPeriodComparison = async () => {
    setPeriodComparing(true);
    const backtestStrategy: "dual_ma" | "sma_rsi_pullback" = strategy === "sma_rsi_pullback" ? "sma_rsi_pullback" : "dual_ma";
    const intervals = ["15m", "1h", "4h"];
    const rows = await Promise.all(intervals.map(async (targetInterval) => {
      const commonParams = { exchange: historicalSource, symbol: "ETH_USDT", interval: targetInterval, strategy: backtestStrategy, fastPeriod, slowPeriod, rsiPeriod, longRsiMax, shortRsiMin, adxPeriod, minAdx, atrPeriod, atrStopMultiplier, atrTrailMultiplier, takeProfitAtrMultiplier, useTrailingStop, feeRate, slippageRate, cooldownBars, maxHoldBars, tradeDirection, signalDelayBars, conservativeSameBarExit };
      const [real, ideal] = await Promise.all([
        runBacktest(commonParams),
        runBacktest({ ...commonParams, minAdx: 0, useTrailingStop: false, feeRate: 0, slippageRate: 0, cooldownBars: 0, maxHoldBars: 0 }),
      ]);
      return { interval: targetInterval, real, ideal, error: real ? undefined : "本地样本不足" };
    }));
    setPeriodRows(rows);
    setPeriodComparing(false);
  };

  const runDirectionStability = async () => {
    setDirectionStabilityLoading(true);
    setDirectionStabilityRows([]);
    setDirectionStabilityProgress("准备验证 12 个方向窗口组合...");
    const windows = [90, 180, 270, 360];
    const directions: TradeDirection[] = ["both", "long_only", "short_only"];
    const combinations = windows.flatMap((windowDays) => directions.map((direction) => ({ windowDays, direction })));
    const rows: DirectionStabilityRow[] = [];
    for (let index = 0; index < combinations.length; index += 3) {
      const batch = combinations.slice(index, index + 3);
      setDirectionStabilityProgress(`正在验证 ${Math.min(index + batch.length, combinations.length)} / ${combinations.length} 个方向窗口组合...`);
      const batchRows = await Promise.all(batch.map(async ({ windowDays, direction }) => {
        const result = await runBacktest({
          exchange: historicalSource,
          symbol: "ETH_USDT",
          interval: "1h",
          limit: windowDays * 24,
          trainRatio: 0.01,
          strategy: "dual_ma",
          fastPeriod,
          slowPeriod,
          rsiPeriod,
          longRsiMax,
          shortRsiMin,
          adxPeriod,
          minAdx,
          atrPeriod,
          atrStopMultiplier,
          atrTrailMultiplier,
          takeProfitAtrMultiplier,
          useTrailingStop,
          feeRate,
          slippageRate,
          cooldownBars,
          maxHoldBars,
          tradeDirection: direction,
          useHigherTimeframeFilter,
          higherTimeframe,
          higherTimeframeSmaPeriod,
          requireHigherTimeframeSlope,
          signalDelayBars,
          conservativeSameBarExit,
        });
        return { windowDays, direction, result, error: result ? undefined : "样本不足" };
      }));
      rows.push(...batchRows);
      setDirectionStabilityRows([...rows]);
    }
    setDirectionStabilityProgress(`方向稳定性验证完成：已验证 ${combinations.length} 个组合。`);
    setDirectionStabilityLoading(false);
  };

  const runConservativeValidation = async () => {
    if (!lockedHigherTimeframeCandidate) {
      setConservativeValidationRows([]);
      setConservativeValidationProgress("请先在高周期过滤参数优化中锁定一个候选，再运行保守回测对照。");
      return;
    }
    setConservativeValidationLoading(true);
    setConservativeValidationRows([]);
    setConservativeValidationProgress("准备对比锁定候选的普通模式与保守模式...");
    const commonParams = {
      exchange: lockedHigherTimeframeCandidate.exchange,
      symbol: "ETH_USDT",
      interval: lockedHigherTimeframeCandidate.interval,
      strategy: lockedHigherTimeframeCandidate.strategy,
      fastPeriod: lockedHigherTimeframeCandidate.fastPeriod,
      slowPeriod: lockedHigherTimeframeCandidate.slowPeriod,
      rsiPeriod: lockedHigherTimeframeCandidate.rsiPeriod,
      longRsiMax: lockedHigherTimeframeCandidate.longRsiMax,
      shortRsiMin: lockedHigherTimeframeCandidate.shortRsiMin,
      adxPeriod: lockedHigherTimeframeCandidate.adxPeriod,
      minAdx: lockedHigherTimeframeCandidate.minAdx,
      atrPeriod: lockedHigherTimeframeCandidate.atrPeriod,
      atrStopMultiplier: lockedHigherTimeframeCandidate.atrStopMultiplier,
      atrTrailMultiplier: lockedHigherTimeframeCandidate.atrTrailMultiplier,
      takeProfitAtrMultiplier: lockedHigherTimeframeCandidate.takeProfitAtrMultiplier,
      useTrailingStop: lockedHigherTimeframeCandidate.useTrailingStop,
      feeRate: lockedHigherTimeframeCandidate.feeRate,
      slippageRate: lockedHigherTimeframeCandidate.slippageRate,
      cooldownBars: lockedHigherTimeframeCandidate.cooldownBars,
      maxHoldBars: lockedHigherTimeframeCandidate.maxHoldBars,
      tradeDirection: lockedHigherTimeframeCandidate.tradeDirection,
      useHigherTimeframeFilter: lockedHigherTimeframeCandidate.useHigherTimeframeFilter,
      higherTimeframe: lockedHigherTimeframeCandidate.higherTimeframe,
      higherTimeframeSmaPeriod: lockedHigherTimeframeCandidate.higherTimeframeSmaPeriod,
      requireHigherTimeframeSlope: lockedHigherTimeframeCandidate.requireHigherTimeframeSlope,
    };
    const configs: Array<Omit<ConservativeValidationRow, "result" | "error">> = [
      { mode: "normal", label: "普通", signalDelayBars: 0, conservativeSameBarExit: false },
      { mode: "conservative", label: "保守", signalDelayBars: 1, conservativeSameBarExit: true },
    ];
    const rows = await Promise.all(configs.map(async (config) => {
      const result = await runBacktest({
        ...commonParams,
        signalDelayBars: config.signalDelayBars,
        conservativeSameBarExit: config.conservativeSameBarExit,
      });
      return { ...config, result, error: result ? undefined : "样本不足" };
    }));
    setConservativeValidationRows(rows);
    setConservativeValidationProgress("保守回测对照完成：已使用锁定候选验证普通模式与保守模式。");
    setConservativeValidationLoading(false);
  };

  const runHigherTimeframeWindowValidation = async () => {
    if (!lockedHigherTimeframeCandidate) {
      setHigherTimeframeWindowRows([]);
      setHigherTimeframeWindowProgress("请先在高周期过滤参数优化中锁定一个候选，再运行分窗稳定性验证。");
      return;
    }
    setHigherTimeframeWindowLoading(true);
    setHigherTimeframeWindowRows([]);
    setHigherTimeframeWindowProgress("准备使用锁定候选验证 4 个分窗...");
    const windows = [90, 180, 270, 360];
    const rows: HigherTimeframeWindowRow[] = [];
    for (let index = 0; index < windows.length; index += 1) {
      const windowDays = windows[index];
      setHigherTimeframeWindowProgress(`正在验证 ${index + 1} / ${windows.length} 个窗口：最近 ${windowDays} 天...`);
      const commonBase = {
        exchange: lockedHigherTimeframeCandidate.exchange,
        symbol: "ETH_USDT",
        interval: lockedHigherTimeframeCandidate.interval,
        limit: windowDays * 24,
        trainRatio: 0.01,
        strategy: lockedHigherTimeframeCandidate.strategy,
        fastPeriod: lockedHigherTimeframeCandidate.fastPeriod,
        slowPeriod: lockedHigherTimeframeCandidate.slowPeriod,
        rsiPeriod: lockedHigherTimeframeCandidate.rsiPeriod,
        longRsiMax: lockedHigherTimeframeCandidate.longRsiMax,
        shortRsiMin: lockedHigherTimeframeCandidate.shortRsiMin,
        adxPeriod: lockedHigherTimeframeCandidate.adxPeriod,
        minAdx: lockedHigherTimeframeCandidate.minAdx,
        atrPeriod: lockedHigherTimeframeCandidate.atrPeriod,
        atrStopMultiplier: lockedHigherTimeframeCandidate.atrStopMultiplier,
        atrTrailMultiplier: lockedHigherTimeframeCandidate.atrTrailMultiplier,
        takeProfitAtrMultiplier: lockedHigherTimeframeCandidate.takeProfitAtrMultiplier,
        useTrailingStop: lockedHigherTimeframeCandidate.useTrailingStop,
        feeRate: lockedHigherTimeframeCandidate.feeRate,
        slippageRate: lockedHigherTimeframeCandidate.slippageRate,
        cooldownBars: lockedHigherTimeframeCandidate.cooldownBars,
        maxHoldBars: lockedHigherTimeframeCandidate.maxHoldBars,
        signalDelayBars: lockedHigherTimeframeCandidate.signalDelayBars,
        conservativeSameBarExit: lockedHigherTimeframeCandidate.conservativeSameBarExit,
      };
      const [baseline, filtered] = await Promise.all([
        runBacktest({ ...commonBase, tradeDirection: "both", useHigherTimeframeFilter: false }),
        runBacktest({
          ...commonBase,
          tradeDirection: lockedHigherTimeframeCandidate.tradeDirection,
          useHigherTimeframeFilter: lockedHigherTimeframeCandidate.useHigherTimeframeFilter,
          higherTimeframe: lockedHigherTimeframeCandidate.higherTimeframe,
          higherTimeframeSmaPeriod: lockedHigherTimeframeCandidate.higherTimeframeSmaPeriod,
          requireHigherTimeframeSlope: lockedHigherTimeframeCandidate.requireHigherTimeframeSlope,
        }),
      ]);
      rows.push({ windowDays, baseline, filtered, error: baseline && filtered ? undefined : "样本不足" });
      setHigherTimeframeWindowRows([...rows]);
    }
    setHigherTimeframeWindowProgress(`高周期过滤分窗验证完成：已使用锁定候选验证 ${windows.length} 个窗口。`);
    setHigherTimeframeWindowLoading(false);
  };

  const runHigherTimeframeOptimization = async () => {
    setHigherTimeframeOptimizing(true);
    setHigherTimeframeRows([]);
    setCurrentHigherTimeframeRank(null);
    setHigherTimeframeProgress("准备扫描 20 组高周期过滤参数...");
    const timeframeValues: HigherTimeframe[] = ["4h", "1d"];
    const smaValues = [20, 30, 50, 80, 100];
    const slopeValues = [false, true];
    const combinations = timeframeValues.flatMap((targetHigherTimeframe) =>
      smaValues.flatMap((targetSmaPeriod) =>
        slopeValues.map((targetRequireSlope) => ({
          higherTimeframe: targetHigherTimeframe,
          smaPeriod: targetSmaPeriod,
          requireSlope: targetRequireSlope,
        }))
      )
    );
    const rows: HigherTimeframeOptimizationRow[] = [];

    for (let index = 0; index < combinations.length; index += 4) {
      const batch = combinations.slice(index, index + 4);
      setHigherTimeframeProgress(`正在扫描 ${Math.min(index + batch.length, combinations.length)} / ${combinations.length} 组高周期过滤参数...`);
      const batchRows = await Promise.all(batch.map(async (combo) => {
        const commonParams = {
          exchange: historicalSource,
          symbol: "ETH_USDT",
          interval: "1h",
          strategy: "dual_ma" as const,
          fastPeriod,
          slowPeriod,
          rsiPeriod,
          longRsiMax,
          shortRsiMin,
          adxPeriod,
          minAdx,
          atrPeriod,
          atrStopMultiplier,
          atrTrailMultiplier,
          takeProfitAtrMultiplier,
          useTrailingStop,
          feeRate,
          slippageRate,
          cooldownBars,
          maxHoldBars,
          tradeDirection: "both" as const,
          useHigherTimeframeFilter: true,
          higherTimeframe: combo.higherTimeframe,
          higherTimeframeSmaPeriod: combo.smaPeriod,
          requireHigherTimeframeSlope: combo.requireSlope,
          signalDelayBars,
          conservativeSameBarExit,
        };
        const [real, ideal] = await Promise.all([
          runBacktest(commonParams),
          runBacktest({ ...commonParams, useTrailingStop: false, feeRate: 0, slippageRate: 0, cooldownBars: 0, maxHoldBars: 0 }),
        ]);
        const diagnosis = diagnoseOptimization(real, ideal);
        return {
          ...combo,
          real,
          ideal,
          score: scoreOptimization(real),
          tags: diagnosis.tags,
          robust: diagnosis.robust,
          error: real ? undefined : "本地样本不足",
          isCurrent: useHigherTimeframeFilter && tradeDirection === "both" && combo.higherTimeframe === higherTimeframe && combo.smaPeriod === higherTimeframeSmaPeriod && combo.requireSlope === requireHigherTimeframeSlope,
        };
      }));
      rows.push(...batchRows);
      setHigherTimeframeRows([...rows].sort((a, b) => Number(b.robust) - Number(a.robust) || b.score - a.score).slice(0, 10));
    }

    const sortedAll = [...rows].sort((a, b) => Number(b.robust) - Number(a.robust) || b.score - a.score).map((row, index) => ({ ...row, rank: index + 1 }));
    const currentIndex = sortedAll.findIndex((row) => row.isCurrent);
    setCurrentHigherTimeframeRank(currentIndex >= 0 ? currentIndex + 1 : null);
    const topRows = sortedAll.slice(0, 10);
    const currentRow = currentIndex >= 10 ? sortedAll[currentIndex] : null;
    setHigherTimeframeRows(currentRow ? [...topRows, currentRow] : topRows);
    setHigherTimeframeProgress(`高周期过滤优化完成：已扫描 ${combinations.length} 组参数，优先展示稳健候选、综合评分前 10 名${useHigherTimeframeFilter && tradeDirection === "both" ? "和当前页面参数" : "；当前页面未启用双向高周期过滤，当前排名不适用"}。`);
    setHigherTimeframeOptimizing(false);
  };

  const applyHigherTimeframeBest = (row: HigherTimeframeOptimizationRow) => {
    const metrics = row.real?.split.test.metrics;
    const candidate: LockedHigherTimeframeCandidate = {
      exchange: historicalSource,
      strategy: "dual_ma",
      interval: "1h",
      tradeDirection: "both",
      fastPeriod,
      slowPeriod,
      rsiPeriod,
      longRsiMax,
      shortRsiMin,
      adxPeriod,
      minAdx,
      atrPeriod,
      atrStopMultiplier,
      atrTrailMultiplier,
      takeProfitAtrMultiplier,
      useTrailingStop,
      feeRate,
      slippageRate,
      cooldownBars,
      maxHoldBars,
      signalDelayBars,
      conservativeSameBarExit,
      useHigherTimeframeFilter: true,
      higherTimeframe: row.higherTimeframe,
      higherTimeframeSmaPeriod: row.smaPeriod,
      requireHigherTimeframeSlope: row.requireSlope,
      source: metrics ? {
        totalReturn: metrics.totalReturn,
        profitFactor: metrics.profitFactor,
        maxDrawdown: metrics.maxDrawdown,
        trades: metrics.trades,
      } : undefined,
    };
    setLockedHigherTimeframeCandidate(candidate);
    setMarketInterval("1h");
    setStrategy("dual_ma");
    setParams({
      tradeDirection: "both",
      useHigherTimeframeFilter: true,
      higherTimeframe: row.higherTimeframe,
      higherTimeframeSmaPeriod: row.smaPeriod,
      requireHigherTimeframeSlope: row.requireSlope,
    });
    setHigherTimeframeWindowRows([]);
    setConservativeValidationRows([]);
    setHigherTimeframeWindowProgress("已锁定候选。请重新运行高周期分窗验证，结果将强制使用这组参数。");
    setConservativeValidationProgress("已锁定候选。请重新运行保守回测对照，结果将强制使用这组参数。");
    setValidationMessage(`已应用并锁定高周期过滤第一名：${row.higherTimeframe} / SMA${row.smaPeriod} / ${row.requireSlope ? "斜率确认" : "仅位置"}，后续分窗和保守验证将使用同一口径。`);
  };

  const runParameterOptimization = async () => {
    setOptimizing(true);
    setOptimizationRows([]);
    setOptimizationBenchmark(null);
    setCurrentOptimizationRank(null);
    setOptimizationProgress("准备扫描 1215 组参数...");
    const tradeDirectionValues: TradeDirection[] = ["both", "long_only", "short_only"];
    const minAdxValues = [15, 18, 20];
    const longRsiValues = [38, 40, 42];
    const shortRsiValues = [58, 60, 62];
    const atrTrailValues = [3.0, 3.5, 4.0];
    const takeProfitAtrValues = [0, 1.8, 2.2, 2.6, 3.0];
    const combinations = tradeDirectionValues.flatMap((targetTradeDirection) =>
      minAdxValues.flatMap((targetMinAdx) =>
        longRsiValues.flatMap((targetLongRsiMax) =>
          shortRsiValues.flatMap((targetShortRsiMin) =>
            atrTrailValues.flatMap((targetAtrTrailMultiplier) =>
              takeProfitAtrValues.map((targetTakeProfitAtrMultiplier) => ({
                tradeDirection: targetTradeDirection,
                minAdx: targetMinAdx,
                longRsiMax: targetLongRsiMax,
                shortRsiMin: targetShortRsiMin,
                atrTrailMultiplier: targetAtrTrailMultiplier,
                takeProfitAtrMultiplier: targetTakeProfitAtrMultiplier,
              }))
            )
          )
        )
      )
    );
    const rows: OptimizationRow[] = [];
    const benchmark = await runBacktest({
      exchange: historicalSource,
      symbol: "ETH_USDT",
      interval: "1h",
      strategy: "sma_rsi_pullback",
      fastPeriod,
      slowPeriod,
      rsiPeriod,
      longRsiMax,
      shortRsiMin,
      adxPeriod,
      minAdx,
      atrPeriod,
      atrStopMultiplier,
      atrTrailMultiplier,
      takeProfitAtrMultiplier,
      useTrailingStop,
      feeRate,
      slippageRate,
      cooldownBars,
      maxHoldBars,
          tradeDirection,
          useHigherTimeframeFilter,
          higherTimeframe,
          higherTimeframeSmaPeriod,
          requireHigherTimeframeSlope,
          signalDelayBars,
          conservativeSameBarExit,
        });
    setOptimizationBenchmark(benchmark);
    const batchSize = 6;

    for (let index = 0; index < combinations.length; index += batchSize) {
      const batch = combinations.slice(index, index + batchSize);
      setOptimizationProgress(`正在扫描 ${Math.min(index + batch.length, combinations.length)} / ${combinations.length} 组参数...`);
      const batchRows = await Promise.all(batch.map(async (combo) => {
        const commonParams = {
          exchange: historicalSource,
          symbol: "ETH_USDT",
          interval: "1h",
          strategy: "sma_rsi_pullback" as const,
          fastPeriod,
          slowPeriod,
          rsiPeriod,
          longRsiMax: combo.longRsiMax,
          shortRsiMin: combo.shortRsiMin,
          adxPeriod,
          minAdx: combo.minAdx,
          atrPeriod,
          atrStopMultiplier,
          atrTrailMultiplier: combo.atrTrailMultiplier,
          takeProfitAtrMultiplier: combo.takeProfitAtrMultiplier,
          useTrailingStop,
          feeRate,
          slippageRate,
          cooldownBars,
          maxHoldBars,
          tradeDirection: combo.tradeDirection,
        };
        const [real, ideal] = await Promise.all([
          runBacktest(commonParams),
          runBacktest({ ...commonParams, minAdx: 0, useTrailingStop: false, feeRate: 0, slippageRate: 0, cooldownBars: 0, maxHoldBars: 0 }),
        ]);
        const diagnosis = diagnoseOptimization(real, ideal);
        return {
          ...combo,
          real,
          ideal,
          score: scoreOptimization(real),
          tags: diagnosis.tags,
          robust: diagnosis.robust,
          error: real ? undefined : "本地样本不足",
          isCurrent: strategy === "sma_rsi_pullback" && combo.tradeDirection === tradeDirection && combo.minAdx === minAdx && combo.longRsiMax === longRsiMax && combo.shortRsiMin === shortRsiMin && combo.atrTrailMultiplier === atrTrailMultiplier && combo.takeProfitAtrMultiplier === takeProfitAtrMultiplier,
        };
      }));
      rows.push(...batchRows);
      const sorted = [...rows].sort((a, b) => Number(b.robust) - Number(a.robust) || b.score - a.score).slice(0, 10);
      setOptimizationRows(sorted);
    }

    const sortedAll = [...rows].sort((a, b) => Number(b.robust) - Number(a.robust) || b.score - a.score).map((row, index) => ({ ...row, rank: index + 1 }));
    const currentIndex = sortedAll.findIndex((row) => row.isCurrent);
    setCurrentOptimizationRank(currentIndex >= 0 ? currentIndex + 1 : null);
    const topRows = sortedAll.slice(0, 10);
    const currentRow = currentIndex >= 10 ? sortedAll[currentIndex] : null;
    setOptimizationRows(currentRow ? [...topRows, currentRow] : topRows);
    setOptimizationProgress(`优化完成：已扫描 ${combinations.length} 组参数，优先展示稳健候选、综合评分前 10 名${strategy === "sma_rsi_pullback" ? "和当前页面参数" : "；当前页面为双均线，SMA+RSI当前排名不适用"}。`);
    setOptimizing(false);
  };

  const runDualMaOptimization = async () => {
    setDualOptimizing(true);
    setDualOptimizationRows([]);
    setDualOptimizationBenchmark(null);
    setCurrentDualOptimizationRank(null);
    const fastValues = [8, 10, 12, 15, 20];
    const slowValues = [30, 40, 50, 60];
    const atrStopValues = [1.5, 1.8, 2.2];
    const atrTrailValues = [3.0, 3.5, 4.0];
    const takeProfitAtrValues = [0, 1.8, 2.2];
    const combinations = fastValues.flatMap((targetFastPeriod) =>
      slowValues.flatMap((targetSlowPeriod) =>
        atrStopValues.flatMap((targetAtrStopMultiplier) =>
          atrTrailValues.flatMap((targetAtrTrailMultiplier) =>
            takeProfitAtrValues.map((targetTakeProfitAtrMultiplier) => ({
              fastPeriod: targetFastPeriod,
              slowPeriod: targetSlowPeriod,
              atrStopMultiplier: targetAtrStopMultiplier,
              atrTrailMultiplier: targetAtrTrailMultiplier,
              takeProfitAtrMultiplier: targetTakeProfitAtrMultiplier,
            }))
          )
        )
      )
    );
    setDualOptimizationProgress(`准备扫描 ${combinations.length} 组双均线只做空参数...`);
    const benchmark = await runBacktest({
      exchange: historicalSource,
      symbol: "ETH_USDT",
      interval: "1h",
      strategy: "dual_ma",
      fastPeriod,
      slowPeriod,
      rsiPeriod,
      longRsiMax,
      shortRsiMin,
      adxPeriod,
      minAdx,
      atrPeriod,
      atrStopMultiplier,
      atrTrailMultiplier,
      takeProfitAtrMultiplier,
      useTrailingStop,
      feeRate,
      slippageRate,
      cooldownBars,
      maxHoldBars,
      tradeDirection: "short_only",
      useHigherTimeframeFilter,
      higherTimeframe,
      higherTimeframeSmaPeriod,
      requireHigherTimeframeSlope,
      signalDelayBars,
      conservativeSameBarExit,
    });
    setDualOptimizationBenchmark(benchmark);

    const rows: DualMaOptimizationRow[] = [];
    const batchSize = 6;
    for (let index = 0; index < combinations.length; index += batchSize) {
      const batch = combinations.slice(index, index + batchSize);
      setDualOptimizationProgress(`正在扫描 ${Math.min(index + batch.length, combinations.length)} / ${combinations.length} 组双均线参数...`);
      const batchRows = await Promise.all(batch.map(async (combo) => {
        const commonParams = {
          exchange: historicalSource,
          symbol: "ETH_USDT",
          interval: "1h",
          strategy: "dual_ma" as const,
          fastPeriod: combo.fastPeriod,
          slowPeriod: combo.slowPeriod,
          rsiPeriod,
          longRsiMax,
          shortRsiMin,
          adxPeriod,
          minAdx,
          atrPeriod,
          atrStopMultiplier: combo.atrStopMultiplier,
          atrTrailMultiplier: combo.atrTrailMultiplier,
          takeProfitAtrMultiplier: combo.takeProfitAtrMultiplier,
          useTrailingStop,
          feeRate,
          slippageRate,
          cooldownBars,
          maxHoldBars,
          tradeDirection: "short_only" as const,
          useHigherTimeframeFilter,
          higherTimeframe,
          higherTimeframeSmaPeriod,
          requireHigherTimeframeSlope,
          signalDelayBars,
          conservativeSameBarExit,
        };
        const [real, ideal] = await Promise.all([
          runBacktest(commonParams),
          runBacktest({ ...commonParams, useTrailingStop: false, feeRate: 0, slippageRate: 0, cooldownBars: 0, maxHoldBars: 0 }),
        ]);
        const diagnosis = diagnoseOptimization(real, ideal);
        return {
          ...combo,
          real,
          ideal,
          score: scoreOptimization(real),
          tags: diagnosis.tags,
          robust: diagnosis.robust,
          error: real ? undefined : "本地样本不足",
          isCurrent: strategy !== "sma_rsi_pullback" && tradeDirection === "short_only" && combo.fastPeriod === fastPeriod && combo.slowPeriod === slowPeriod && combo.atrStopMultiplier === atrStopMultiplier && combo.atrTrailMultiplier === atrTrailMultiplier && combo.takeProfitAtrMultiplier === takeProfitAtrMultiplier,
        };
      }));
      rows.push(...batchRows);
      setDualOptimizationRows([...rows].sort((a, b) => Number(b.robust) - Number(a.robust) || b.score - a.score).slice(0, 10));
    }

    const sortedAll = [...rows].sort((a, b) => Number(b.robust) - Number(a.robust) || b.score - a.score).map((row, index) => ({ ...row, rank: index + 1 }));
    const currentIndex = sortedAll.findIndex((row) => row.isCurrent);
    setCurrentDualOptimizationRank(currentIndex >= 0 ? currentIndex + 1 : null);
    const topRows = sortedAll.slice(0, 10);
    const currentRow = currentIndex >= 10 ? sortedAll[currentIndex] : null;
    setDualOptimizationRows(currentRow ? [...topRows, currentRow] : topRows);
    setDualOptimizationProgress(`双均线优化完成：已扫描 ${combinations.length} 组参数，优先展示稳健候选、综合评分前 10 名和当前页面参数。`);
    setDualOptimizing(false);
  };

  const runDualMaLongOptimization = async () => {
    setDualLongOptimizing(true);
    setDualLongOptimizationRows([]);
    setDualLongOptimizationBenchmark(null);
    setCurrentDualLongOptimizationRank(null);
    const fastValues = [8, 10, 12, 15, 20];
    const slowValues = [30, 40, 50, 60];
    const atrStopValues = [1.5, 1.8, 2.2];
    const atrTrailValues = [3.0, 3.5, 4.0];
    const takeProfitAtrValues = [0, 1.8, 2.2];
    const combinations = fastValues.flatMap((targetFastPeriod) =>
      slowValues.flatMap((targetSlowPeriod) =>
        atrStopValues.flatMap((targetAtrStopMultiplier) =>
          atrTrailValues.flatMap((targetAtrTrailMultiplier) =>
            takeProfitAtrValues.map((targetTakeProfitAtrMultiplier) => ({
              fastPeriod: targetFastPeriod,
              slowPeriod: targetSlowPeriod,
              atrStopMultiplier: targetAtrStopMultiplier,
              atrTrailMultiplier: targetAtrTrailMultiplier,
              takeProfitAtrMultiplier: targetTakeProfitAtrMultiplier,
            }))
          )
        )
      )
    );
    setDualLongOptimizationProgress(`准备扫描 ${combinations.length} 组双均线只做多参数...`);
    const benchmark = await runBacktest({
      exchange: historicalSource,
      symbol: "ETH_USDT",
      interval: "1h",
      strategy: "dual_ma",
      fastPeriod,
      slowPeriod,
      rsiPeriod,
      longRsiMax,
      shortRsiMin,
      adxPeriod,
      minAdx,
      atrPeriod,
      atrStopMultiplier,
      atrTrailMultiplier,
      takeProfitAtrMultiplier,
      useTrailingStop,
      feeRate,
      slippageRate,
      cooldownBars,
      maxHoldBars,
      tradeDirection: "long_only",
      signalDelayBars,
      conservativeSameBarExit,
    });
    setDualLongOptimizationBenchmark(benchmark);

    const rows: DualMaOptimizationRow[] = [];
    const batchSize = 6;
    for (let index = 0; index < combinations.length; index += batchSize) {
      const batch = combinations.slice(index, index + batchSize);
      setDualLongOptimizationProgress(`正在扫描 ${Math.min(index + batch.length, combinations.length)} / ${combinations.length} 组双均线只做多参数...`);
      const batchRows = await Promise.all(batch.map(async (combo) => {
        const commonParams = {
          exchange: historicalSource,
          symbol: "ETH_USDT",
          interval: "1h",
          strategy: "dual_ma" as const,
          fastPeriod: combo.fastPeriod,
          slowPeriod: combo.slowPeriod,
          rsiPeriod,
          longRsiMax,
          shortRsiMin,
          adxPeriod,
          minAdx,
          atrPeriod,
          atrStopMultiplier: combo.atrStopMultiplier,
          atrTrailMultiplier: combo.atrTrailMultiplier,
          takeProfitAtrMultiplier: combo.takeProfitAtrMultiplier,
          useTrailingStop,
          feeRate,
          slippageRate,
          cooldownBars,
          maxHoldBars,
          tradeDirection: "long_only" as const,
          signalDelayBars,
          conservativeSameBarExit,
        };
        const [real, ideal] = await Promise.all([
          runBacktest(commonParams),
          runBacktest({ ...commonParams, useTrailingStop: false, feeRate: 0, slippageRate: 0, cooldownBars: 0, maxHoldBars: 0 }),
        ]);
        const diagnosis = diagnoseOptimization(real, ideal);
        return {
          ...combo,
          real,
          ideal,
          score: scoreOptimization(real),
          tags: diagnosis.tags,
          robust: diagnosis.robust,
          error: real ? undefined : "本地样本不足",
          isCurrent: strategy !== "sma_rsi_pullback" && tradeDirection === "long_only" && combo.fastPeriod === fastPeriod && combo.slowPeriod === slowPeriod && combo.atrStopMultiplier === atrStopMultiplier && combo.atrTrailMultiplier === atrTrailMultiplier && combo.takeProfitAtrMultiplier === takeProfitAtrMultiplier,
        };
      }));
      rows.push(...batchRows);
      setDualLongOptimizationRows([...rows].sort((a, b) => Number(b.robust) - Number(a.robust) || b.score - a.score).slice(0, 10));
    }

    const sortedAll = [...rows].sort((a, b) => Number(b.robust) - Number(a.robust) || b.score - a.score).map((row, index) => ({ ...row, rank: index + 1 }));
    const currentIndex = sortedAll.findIndex((row) => row.isCurrent);
    setCurrentDualLongOptimizationRank(currentIndex >= 0 ? currentIndex + 1 : null);
    const topRows = sortedAll.slice(0, 10);
    const currentRow = currentIndex >= 10 ? sortedAll[currentIndex] : null;
    setDualLongOptimizationRows(currentRow ? [...topRows, currentRow] : topRows);
    setDualLongOptimizationProgress(`双均线只做多优化完成：已扫描 ${combinations.length} 组参数，优先展示稳健候选、综合评分前 10 名和当前页面参数。`);
    setDualLongOptimizing(false);
  };

  const applyDualMaBest = (row: DualMaOptimizationRow, direction: TradeDirection) => {
    setMarketInterval("1h");
    setStrategy("dual_ma");
    setParams({
      fastPeriod: row.fastPeriod,
      slowPeriod: row.slowPeriod,
      atrStopMultiplier: row.atrStopMultiplier,
      atrTrailMultiplier: row.atrTrailMultiplier,
      takeProfitAtrMultiplier: row.takeProfitAtrMultiplier,
      tradeDirection: direction,
    });
    setValidationMessage(`已应用双均线${directionText(direction)}优化第一名，并切换到 ETH_USDT / 1h / 双均线 / ${directionText(direction)}，正在重新验证主回测...`);
  };

  const runBackfill = async () => {
    setBackfilling(true);
    setBackfillMessage(null);
    setValidationMessage(null);
    setBackfillJob(null);
    setError(null);
    const symbols = backfillSymbols.split(",").map((s) => s.trim()).filter(Boolean);
    const intervals = backfillIntervals.split(",").map((s) => s.trim()).filter(Boolean);
    const data = await backfillLocalCandles({ exchange: historicalSource, symbols, intervals, days: backfillDays });
    if (!data?.job) {
      setBackfillMessage("补充历史数据失败，请确认本地后端已启动");
      setBackfilling(false);
      saveBackfillJob(null);
    } else {
      saveBackfillJob(data.job);
      setBackfillJob(data.job);
      setBackfillMessage(`${data.job.exchange.toUpperCase()} 补数任务已启动，刷新页面后会自动恢复进度`);
    }
  };

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "20px", display: "flex", flexDirection: "column", gap: "16px" }}>
      <div style={{ backgroundColor: "var(--color-bg-card)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <BarChart3 size={22} style={{ color: "var(--color-btn-primary)" }} />
          <div>
            <div style={{ fontSize: "16px", color: "var(--color-text-primary)", fontWeight: 600 }}>样本外回测验证</div>
            <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "4px" }}>使用本地长期K线做 70% 训练段 / 30% 测试段切分，当前按 {historicalSource.toUpperCase()} 数据验证 {strategy === "sma_rsi_pullback" ? "SMA+RSI回调" : "双均线"} 信号。</div>
          </div>
        </div>
        <button onClick={() => void load()} disabled={loading} style={{ display: "flex", alignItems: "center", gap: "6px", padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--color-border)", background: loading ? "rgba(26,115,232,0.14)" : "var(--color-bg-elevated)", color: loading ? "var(--color-btn-primary)" : "var(--color-text-primary)", cursor: loading ? "default" : "pointer" }}>
          <RefreshCw size={14} style={{ animation: loading ? "spin 1s linear infinite" : undefined }} />{loading ? "验证中..." : "重新验证"}
        </button>
      </div>

      <div style={{ backgroundColor: "var(--color-bg-card)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "16px", display: "grid", gridTemplateColumns: "repeat(5, minmax(120px, 1fr))", gap: "10px", color: "var(--color-text-secondary)", fontSize: "12px" }}>
        <MetricCard label="历史数据源" value={historicalSource.toUpperCase()} />
        <MetricCard label="回测策略" value={strategy === "sma_rsi_pullback" ? "SMA+RSI" : "双均线"} />
        <MetricCard label="本地样本数" value={String(range?.count ?? 0)} />
        <MetricCard label="起始时间" value={fmtTime(range?.minTime)} />
        <MetricCard label="最新时间" value={fmtTime(range?.maxTime)} />
      </div>

      <div style={{ backgroundColor: "var(--color-bg-card)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
        <div style={{ fontSize: "13px", color: "var(--color-text-primary)", fontWeight: 600 }}>回测风控参数</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(100px, 1fr))", gap: "10px" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: "4px", color: "var(--color-text-secondary)", fontSize: "11px" }}>
            <span>交易方向</span>
            <select value={tradeDirection} onChange={(e) => setParams({ tradeDirection: e.target.value as TradeDirection })} style={{ width: "100%", boxSizing: "border-box" }}>
              <option value="both">双向</option>
              <option value="long_only">只做多</option>
              <option value="short_only">只做空</option>
            </select>
          </label>
          <ParamInput label="最小ADX" value={minAdx} onChange={(v) => setParams({ minAdx: v })} min={10} max={45} step={1} />
          <ParamInput label="ATR止损倍数" value={atrStopMultiplier} onChange={(v) => setParams({ atrStopMultiplier: v })} min={0.5} max={5} step={0.1} />
          <ParamInput label="ATR追踪倍数" value={atrTrailMultiplier} onChange={(v) => setParams({ atrTrailMultiplier: v })} min={0.5} max={6} step={0.1} />
          <ParamInput label="ATR止盈倍数" value={takeProfitAtrMultiplier} onChange={(v) => setParams({ takeProfitAtrMultiplier: v })} min={0} max={6} step={0.1} />
          <ParamInput label="手续费率" value={feeRate} onChange={(v) => setParams({ feeRate: v })} min={0} max={0.005} step={0.0001} />
          <ParamInput label="滑点率" value={slippageRate} onChange={(v) => setParams({ slippageRate: v })} min={0} max={0.005} step={0.0001} />
          <ParamInput label="冷却K线" value={cooldownBars} onChange={(v) => setParams({ cooldownBars: v })} min={0} max={50} step={1} />
          <ParamInput label="最大持仓K线" value={maxHoldBars} onChange={(v) => setParams({ maxHoldBars: v })} min={0} max={500} step={1} />
          <label style={{ display: "flex", flexDirection: "column", gap: "4px", color: "var(--color-text-secondary)", fontSize: "11px" }}>
            <span>高周期过滤</span>
            <select value={higherTimeframe} onChange={(e) => setParams({ higherTimeframe: e.target.value as HigherTimeframe })} disabled={!useHigherTimeframeFilter} style={{ width: "100%", boxSizing: "border-box" }}>
              <option value="4h">4h趋势</option>
              <option value="1d">1d趋势</option>
            </select>
          </label>
          <ParamInput label="高周期SMA" value={higherTimeframeSmaPeriod} onChange={(v) => setParams({ higherTimeframeSmaPeriod: v })} min={10} max={200} step={1} />
          <ParamInput label="信号延迟K线" value={signalDelayBars} onChange={(v) => setParams({ signalDelayBars: v })} min={0} max={5} step={1} />
          <label style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--color-text-secondary)", fontSize: "12px" }}>
            <input type="checkbox" checked={useHigherTimeframeFilter} onChange={(e) => setParams({ useHigherTimeframeFilter: e.target.checked })} />启用高周期趋势过滤
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--color-text-secondary)", fontSize: "12px" }}>
            <input type="checkbox" checked={requireHigherTimeframeSlope} onChange={(e) => setParams({ requireHigherTimeframeSlope: e.target.checked })} disabled={!useHigherTimeframeFilter} />高周期SMA需同向倾斜
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--color-text-secondary)", fontSize: "12px" }}>
            <input type="checkbox" checked={conservativeSameBarExit} onChange={(e) => setParams({ conservativeSameBarExit: e.target.checked })} />同K线冲突优先止损
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--color-text-secondary)", fontSize: "12px" }}>
            <input type="checkbox" checked={useTrailingStop} onChange={(e) => setParams({ useTrailingStop: e.target.checked })} />启用ATR追踪止损
          </label>
        </div>
      </div>

      <div style={{ backgroundColor: "var(--color-bg-card)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "16px", display: "flex", flexDirection: "column", gap: "12px", color: "var(--color-text-secondary)", fontSize: "12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <Database size={15} />
          <span>数据要求：建议至少 180 天 15m/1h K线。长历史优先用 OKX；Gate 只适合补最近约 10000 根内的数据。测试集结果只用于检验，不应看完后反向调参。</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "120px 1fr 1fr auto", gap: "10px", alignItems: "end" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <span>补充天数</span>
            <input type="number" min={1} max={730} value={backfillDays} onChange={(e) => setBackfillDays(Number(e.target.value))} style={{ width: "100%" }} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <span>标的，逗号分隔</span>
            <input value={backfillSymbols} onChange={(e) => setBackfillSymbols(e.target.value)} style={{ width: "100%" }} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <span>周期，逗号分隔</span>
            <input value={backfillIntervals} onChange={(e) => setBackfillIntervals(e.target.value)} style={{ width: "100%" }} />
          </label>
          <button onClick={runBackfill} disabled={backfilling} style={{ display: "flex", alignItems: "center", gap: "6px", padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--color-border)", background: "var(--color-bg-elevated)", color: "var(--color-text-primary)", cursor: backfilling ? "default" : "pointer" }}>
            <Database size={14} />{backfilling ? "补充中" : "补充历史数据"}
          </button>
        </div>
        {backfillJob && (
          <div style={{ backgroundColor: "rgba(255,255,255,0.03)", border: "1px solid var(--color-border)", borderRadius: "8px", padding: "10px", fontFamily: "var(--font-mono)", lineHeight: 1.6 }}>
            <div>任务：{backfillJob.id} · {backfillJob.status} · {backfillJob.exchange.toUpperCase()} · 已写入 {backfillJob.inserted} 根</div>
            <div>当前：{backfillJob.currentMessage}</div>
            <div style={{ color: "var(--color-text-secondary)" }}>{backfillJob.messages.slice(-3).join(" / ")}</div>
          </div>
        )}
      </div>

      <PeriodComparison rows={periodRows} loading={periodComparing} onRun={() => void runPeriodComparison()} />

      <DirectionStability rows={directionStabilityRows} loading={directionStabilityLoading} progress={directionStabilityProgress} onRun={() => void runDirectionStability()} />

      <HigherTimeframeOptimization rows={higherTimeframeRows} loading={higherTimeframeOptimizing} progress={higherTimeframeProgress} currentRank={currentHigherTimeframeRank} onRun={() => void runHigherTimeframeOptimization()} onApply={applyHigherTimeframeBest} />

      <HigherTimeframeWindowValidation rows={higherTimeframeWindowRows} loading={higherTimeframeWindowLoading} progress={higherTimeframeWindowProgress} lockedCandidate={lockedHigherTimeframeCandidate} onRun={() => void runHigherTimeframeWindowValidation()} />

      <ConservativeValidation rows={conservativeValidationRows} loading={conservativeValidationLoading} progress={conservativeValidationProgress} lockedCandidate={lockedHigherTimeframeCandidate} onRun={() => void runConservativeValidation()} />

      <DefaultBenchmark benchmark={optimizationBenchmark} best={optimizationRows[0] ?? null} />

      <ParameterOptimization rows={optimizationRows} loading={optimizing} progress={optimizationProgress} currentRank={currentOptimizationRank} activeStrategy={strategy} onRun={() => void runParameterOptimization()} />

      <DualMaDirectionalOptimization
        title="双均线只做多专项优化"
        description="固定 ETH_USDT / 1h / 双均线 / 只做多，扫描快慢均线、ATR止损、ATR追踪和ATR止盈；用于验证 360 天样本里更有效的多头趋势路线。"
        emptyText="点击“运行只做多优化”开始扫描。建议先确保 OKX 已补充至少 360 天 1h 数据。"
        runButtonText="运行只做多优化"
        rows={dualLongOptimizationRows}
        benchmark={dualLongOptimizationBenchmark}
        loading={dualLongOptimizing}
        progress={dualLongOptimizationProgress}
        currentRank={currentDualLongOptimizationRank}
        direction="long_only"
        onRun={() => void runDualMaLongOptimization()}
        onApply={applyDualMaBest}
      />

      <DualMaDirectionalOptimization
        title="双均线只做空专项优化"
        description="固定 ETH_USDT / 1h / 双均线 / 只做空，扫描快慢均线、ATR止损、ATR追踪和ATR止盈；用于复核近期窗口中的空头趋势路线是否仍然稳定。"
        emptyText="点击“运行只做空优化”开始扫描。建议先确保 OKX 已补充至少 180 天 1h 数据。"
        runButtonText="运行只做空优化"
        rows={dualOptimizationRows}
        benchmark={dualOptimizationBenchmark}
        loading={dualOptimizing}
        progress={dualOptimizationProgress}
        currentRank={currentDualOptimizationRank}
        direction="short_only"
        onRun={() => void runDualMaOptimization()}
        onApply={applyDualMaBest}
      />

      {validationMessage && (
        <div style={{ backgroundColor: loading ? "rgba(26,115,232,0.08)" : "rgba(0,255,136,0.08)", border: `1px solid ${loading ? "rgba(26,115,232,0.25)" : "rgba(0,255,136,0.25)"}`, borderRadius: "10px", padding: "14px", color: loading ? "var(--color-btn-primary)" : "var(--color-long)", fontSize: "13px", lineHeight: 1.6 }}>{validationMessage}</div>
      )}

      {backfillMessage && (
        <div style={{ backgroundColor: "rgba(0,255,136,0.08)", border: "1px solid rgba(0,255,136,0.25)", borderRadius: "10px", padding: "14px", color: "var(--color-long)", fontSize: "13px", lineHeight: 1.6 }}>{backfillMessage}</div>
      )}

      {error && (
        <div style={{ backgroundColor: "rgba(255,170,0,0.08)", border: "1px solid rgba(255,170,0,0.25)", borderRadius: "10px", padding: "14px", color: "#ffaa00", fontSize: "13px", lineHeight: 1.6 }}>{error}</div>
      )}

      {result && (
        <>
          <StrategyDiagnosis result={result} idealResult={idealResult} interval={interval} />
          <DirectionBreakdownTable breakdown={result.split.test.directionBreakdown} />
          <WalkForwardTable rows={result.walkForward} />
          {idealResult && (
            <section style={{ backgroundColor: "var(--color-bg-card)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "16px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", marginBottom: "12px" }}>
                <div style={{ fontSize: "13px", color: "var(--color-text-primary)", fontWeight: 600 }}>理想 / 真实测试段对照</div>
                <div style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>理想模式关闭手续费、滑点、ADX过滤、冷却期、ATR追踪止损和最大持仓限制</div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(120px, 1fr))", gap: "10px" }}>
                <MetricCard label="理想测试收益" value={pct(idealResult.split.test.metrics.totalReturn)} hint={`交易 ${idealResult.split.test.metrics.trades} 笔`} />
                <MetricCard label="真实测试收益" value={pct(result.split.test.metrics.totalReturn)} hint={`交易 ${result.split.test.metrics.trades} 笔`} />
                <MetricCard label="摩擦/过滤差值" value={pct(idealResult.split.test.metrics.totalReturn - result.split.test.metrics.totalReturn)} hint="差值越大，说明交易成本或风控过滤影响越明显" />
                <MetricCard label="真实收益因子" value={num(result.split.test.metrics.profitFactor)} hint="低于1说明当前参数在测试段没有正期望" />
              </div>
            </section>
          )}
          <section style={{ backgroundColor: "var(--color-bg-card)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "16px" }}>
            <div style={{ fontSize: "13px", color: "var(--color-text-primary)", marginBottom: "12px", fontWeight: 600 }}>真实模式：训练段表现</div>
            <MetricsGrid metrics={result.split.train.metrics} exitReasons={result.split.train.exitReasons} />
          </section>
          <section style={{ backgroundColor: "var(--color-bg-card)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "16px" }}>
            <div style={{ fontSize: "13px", color: "var(--color-text-primary)", marginBottom: "12px", fontWeight: 600 }}>真实模式：测试段表现</div>
            <MetricsGrid metrics={result.split.test.metrics} exitReasons={result.split.test.exitReasons} />
          </section>
        </>
      )}
    </div>
  );
}
