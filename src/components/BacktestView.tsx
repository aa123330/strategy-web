import { useCallback, useEffect, useState } from "react";
import { BarChart3, Database, RefreshCw } from "lucide-react";
import { useMarketStore, useStrategyStore, type HigherTimeframe } from "../store";
import { backfillLocalCandles, getBackfillJob, getLocalCandles, runBacktest, type BackfillJob, type BacktestMetrics, type BacktestResult, type BacktestTrade, type BreadthNeutralMode, type CandleRange, type DirectionBreakdown, type MarketBreadthDiagnostics, type TradeDirection } from "../services/localDataApi";

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

function monthKey(ts: number) {
  const date = new Date(ts * 1000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function metricsFromTrades(trades: BacktestTrade[]): Pick<BacktestMetrics, "totalReturn" | "profitFactor" | "winRate" | "trades"> {
  const wins = trades.filter((trade) => trade.pnlPct > 0);
  const losses = trades.filter((trade) => trade.pnlPct <= 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.pnlPct, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.pnlPct, 0));
  const equity = trades.reduce((value, trade) => value * (1 + trade.pnlPct), 1);
  return {
    trades: trades.length,
    totalReturn: equity - 1,
    winRate: trades.length ? wins.length / trades.length : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0,
  };
}

function avg(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function breadthBiasText(bias: "bull" | "bear" | "neutral") {
  const map = { bull: "多头广度", bear: "空头广度", neutral: "中性广度" };
  return map[bias];
}

function nearestCandle(candles: Array<{ time: number; open: number; high: number; low: number; close: number }>, targetTime: number) {
  let best = candles[0] ?? null;
  for (const candle of candles) {
    if (candle.time <= targetTime) best = candle;
    else break;
  }
  return best;
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

interface MarketBreadthWindowRow {
  windowDays: number;
  baseline: BacktestResult | null;
  filtered: BacktestResult | null;
  error?: string;
}

interface MarketBreadthConservativeRow {
  mode: "normal" | "conservative";
  label: string;
  signalDelayBars: number;
  conservativeSameBarExit: boolean;
  result: BacktestResult | null;
  error?: string;
}

interface MarketBreadthStateRow {
  bias: "bull" | "bear" | "neutral";
  baseline: Pick<BacktestMetrics, "totalReturn" | "profitFactor" | "winRate" | "trades">;
  kept: Pick<BacktestMetrics, "totalReturn" | "profitFactor" | "winRate" | "trades">;
  filtered: Pick<BacktestMetrics, "totalReturn" | "profitFactor" | "winRate" | "trades">;
  diagnosis: string;
}

interface MarketBreadthStateDiagnostics {
  result: BacktestResult;
  rows: MarketBreadthStateRow[];
}

interface MarketBreadthCoverageDiagnostics {
  result: BacktestResult;
  diagnostics: MarketBreadthDiagnostics;
  conclusion: string;
}

interface MarketBreadthPoolCoverageRow {
  label: string;
  symbols: string[];
  result: BacktestResult | null;
  diagnostics?: MarketBreadthDiagnostics;
  conclusion: string;
  error?: string;
}

interface CandidateDiagnostics {
  result: BacktestResult;
  monthly: Array<{ month: string; trades: number; totalReturn: number; profitFactor: number; winRate: number }>;
  worstMonth: { month: string; totalReturn: number } | null;
  bestMonth: { month: string; totalReturn: number } | null;
  maxDrawdownRun: { startTime: number; endTime: number; drawdown: number } | null;
  worstLossStreak: { count: number; startTime: number; endTime: number; totalReturn: number } | null;
  exitReasonRows: Array<{ reason: string; count: number }>;
}

interface LossZoneDiagnostics {
  result: BacktestResult;
  lossTrades: Array<BacktestTrade & { holdHours: number; month: string; atrPct: number | null; bodyRatio: number | null; distanceToSma: number | null }>;
  monthStates: Array<{ month: string; trades: number; lossTrades: number; totalReturn: number; avgAtrPct: number; avgBodyRatio: number; avgDistanceToSma: number; falseBreakRisk: string }>;
  worstLossMonth: string | null;
}

interface TrendQualityComparisonRow {
  minSlowSmaDistancePct: number;
  minAtrPct: number;
  result: BacktestResult | null;
  aprilReturn: number | null;
  aprilLossTrades: number | null;
  marchReturn: number | null;
  juneReturn: number | null;
  score: number;
  tags: string[];
  error?: string;
}

interface StopLossCircuitComparisonRow {
  lookbackTrades: number;
  minStops: number;
  cooldownBars: number;
  result: BacktestResult | null;
  aprilReturn: number | null;
  aprilLossTrades: number | null;
  marchReturn: number | null;
  juneReturn: number | null;
  score: number;
  tags: string[];
  error?: string;
}

interface MarketBreadthComparisonRow {
  symbols: string[];
  breadthTimeframe: HigherTimeframe;
  breadthSmaPeriod: number;
  threshold: number;
  breadthNeutralMode: BreadthNeutralMode;
  result: BacktestResult | null;
  aprilReturn: number | null;
  aprilLossTrades: number | null;
  marchReturn: number | null;
  juneReturn: number | null;
  score: number;
  tags: string[];
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

interface LockedMarketBreadthCandidate {
  symbols: string[];
  breadthTimeframe: HigherTimeframe;
  breadthSmaPeriod: number;
  threshold: number;
  breadthNeutralMode: BreadthNeutralMode;
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

function lockedMarketBreadthLabel(candidate: LockedMarketBreadthCandidate | null) {
  if (!candidate) return null;
  return `${candidate.breadthTimeframe} / SMA${candidate.breadthSmaPeriod} / 阈值${pct(candidate.threshold)} / ${candidate.breadthNeutralMode === "block_all" ? "中性空仓" : "中性沿用"} / ${candidate.symbols.length}标的`;
}

function candleAtrPct(candles: Array<{ time: number; open: number; high: number; low: number; close: number }>, index: number, period = 14) {
  if (index < period) return null;
  let sum = 0;
  for (let i = index - period + 1; i <= index; i += 1) {
    const current = candles[i];
    const prev = candles[i - 1];
    sum += Math.max(current.high - current.low, Math.abs(current.high - prev.close), Math.abs(current.low - prev.close));
  }
  return sum / period / candles[index].close;
}

function candleSma(candles: Array<{ close: number }>, index: number, period: number) {
  if (index + 1 < period) return null;
  let sum = 0;
  for (let i = index - period + 1; i <= index; i += 1) sum += candles[i].close;
  return sum / period;
}

function buildLossZoneDiagnostics(result: BacktestResult, candles: Array<{ time: number; open: number; high: number; low: number; close: number }>, candidate: LockedHigherTimeframeCandidate): LossZoneDiagnostics {
  const trades = result.split.test.trades ?? [];
  const lossTrades = trades.filter((trade) => trade.pnlPct <= 0).map((trade) => {
    const candleIndex = candles.findIndex((candle) => candle.time >= trade.entryTime);
    const candle = candleIndex >= 0 ? candles[candleIndex] : nearestCandle(candles, trade.entryTime);
    const atrPct = candleIndex >= 0 ? candleAtrPct(candles, candleIndex, candidate.atrPeriod) : null;
    const sma = candleIndex >= 0 ? candleSma(candles, candleIndex, candidate.slowPeriod) : null;
    const range = candle ? Math.max(candle.high - candle.low, 0) : 0;
    return {
      ...trade,
      holdHours: (trade.exitTime - trade.entryTime) / 3600,
      month: monthKey(trade.exitTime),
      atrPct,
      bodyRatio: candle && range > 0 ? Math.abs(candle.close - candle.open) / range : null,
      distanceToSma: candle && sma ? (candle.close - sma) / candle.close : null,
    };
  });
  const monthKeys = [...new Set(trades.map((trade) => monthKey(trade.exitTime)))].sort();
  const monthStates = monthKeys.map((month) => {
    const monthTrades = trades.filter((trade) => monthKey(trade.exitTime) === month);
    const monthLossTrades = lossTrades.filter((trade) => trade.month === month);
    const monthCandles = candles.filter((candle) => monthKey(candle.time) === month);
    const atrValues = monthCandles.map((_, index) => candleAtrPct(monthCandles, index, candidate.atrPeriod)).filter((value): value is number => value !== null);
    const bodyValues = monthCandles.map((candle) => {
      const range = Math.max(candle.high - candle.low, 0);
      return range > 0 ? Math.abs(candle.close - candle.open) / range : 0;
    });
    const distanceValues = monthCandles.map((_, index) => {
      const sma = candleSma(monthCandles, index, candidate.slowPeriod);
      return sma ? Math.abs((monthCandles[index].close - sma) / monthCandles[index].close) : null;
    }).filter((value): value is number => value !== null);
    const stats = metricsFromTrades(monthTrades);
    const avgBodyRatio = avg(bodyValues);
    const avgDistanceToSma = avg(distanceValues);
    const falseBreakRisk = avgBodyRatio < 0.42 && avgDistanceToSma < 0.018 ? "偏震荡/假突破" : avgDistanceToSma < 0.015 ? "贴近均线" : "趋势较清晰";
    return {
      month,
      trades: stats.trades,
      lossTrades: monthLossTrades.length,
      totalReturn: stats.totalReturn,
      avgAtrPct: avg(atrValues),
      avgBodyRatio,
      avgDistanceToSma,
      falseBreakRisk,
    };
  });
  const worstLossMonth = monthStates.length ? monthStates.reduce((worst, row) => row.totalReturn < worst.totalReturn ? row : worst).month : null;
  return { result, lossTrades, monthStates, worstLossMonth };
}

function analyzeCandidate(result: BacktestResult): CandidateDiagnostics {
  const trades = result.split.test.trades ?? [];
  const monthlyMap = new Map<string, BacktestTrade[]>();
  for (const trade of trades) {
    const key = monthKey(trade.exitTime);
    monthlyMap.set(key, [...(monthlyMap.get(key) ?? []), trade]);
  }
  const monthly = [...monthlyMap.entries()].map(([month, monthTrades]) => {
    const stats = metricsFromTrades(monthTrades);
    return { month, trades: stats.trades, totalReturn: stats.totalReturn, profitFactor: stats.profitFactor, winRate: stats.winRate };
  }).sort((a, b) => a.month.localeCompare(b.month));
  const worstMonth = monthly.length ? monthly.reduce((worst, row) => row.totalReturn < worst.totalReturn ? row : worst) : null;
  const bestMonth = monthly.length ? monthly.reduce((best, row) => row.totalReturn > best.totalReturn ? row : best) : null;

  let equity = 1;
  let peak = 1;
  let peakTime = trades[0]?.entryTime ?? 0;
  let maxDrawdownRun: CandidateDiagnostics["maxDrawdownRun"] = null;
  for (const trade of trades) {
    equity *= 1 + trade.pnlPct;
    if (equity > peak) {
      peak = equity;
      peakTime = trade.exitTime;
    }
    const drawdown = equity / peak - 1;
    if (!maxDrawdownRun || drawdown < maxDrawdownRun.drawdown) {
      maxDrawdownRun = { startTime: peakTime, endTime: trade.exitTime, drawdown };
    }
  }

  let currentLosses: BacktestTrade[] = [];
  let worstLosses: BacktestTrade[] = [];
  for (const trade of trades) {
    if (trade.pnlPct <= 0) {
      currentLosses = [...currentLosses, trade];
      if (currentLosses.length > worstLosses.length) worstLosses = currentLosses;
    } else {
      currentLosses = [];
    }
  }
  const worstLossStreak = worstLosses.length
    ? {
      count: worstLosses.length,
      startTime: worstLosses[0].entryTime,
      endTime: worstLosses[worstLosses.length - 1].exitTime,
      totalReturn: metricsFromTrades(worstLosses).totalReturn,
    }
    : null;
  const exitReasonRows = Object.entries(result.split.test.exitReasons ?? {})
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  return { result, monthly, worstMonth, bestMonth, maxDrawdownRun, worstLossStreak, exitReasonRows };
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

function monthReturn(result: BacktestResult | null, month: string) {
  const trades = result?.split.test.trades ?? [];
  const monthTrades = trades.filter((trade) => monthKey(trade.exitTime) === month);
  return monthTrades.length ? metricsFromTrades(monthTrades).totalReturn : null;
}

function monthLossTrades(result: BacktestResult | null, month: string) {
  const trades = result?.split.test.trades ?? [];
  return trades.filter((trade) => monthKey(trade.exitTime) === month && trade.pnlPct <= 0).length;
}

function diagnoseTrendQualityRow(row: TrendQualityComparisonRow, baseline: BacktestResult | null) {
  const metrics = row.result?.split.test.metrics;
  const baseMetrics = baseline?.split.test.metrics;
  const tags: string[] = [];
  if (!metrics || !baseMetrics) return ["样本不足"];
  if (metrics.totalReturn >= baseMetrics.totalReturn * 0.9 && metrics.profitFactor > baseMetrics.profitFactor) tags.push("PF改善");
  if (row.aprilReturn !== null && row.aprilReturn > -0.01) tags.push("4月亏损收窄");
  if (metrics.trades < baseMetrics.trades * 0.6) tags.push("交易过少");
  if (metrics.totalReturn < baseMetrics.totalReturn * 0.75) tags.push("收益牺牲过大");
  if (metrics.maxDrawdown > baseMetrics.maxDrawdown) tags.push("回撤改善");
  return tags.length ? tags : ["变化有限"];
}

function diagnoseStopLossCircuitRow(row: StopLossCircuitComparisonRow, baseline: BacktestResult | null) {
  const metrics = row.result?.split.test.metrics;
  const baseMetrics = baseline?.split.test.metrics;
  const baseAprilReturn = monthReturn(baseline, "2026-04");
  const baseAprilLossTrades = monthLossTrades(baseline, "2026-04");
  const tags: string[] = [];
  if (!metrics || !baseMetrics) return ["样本不足"];
  if (row.aprilReturn !== null && baseAprilReturn !== null && row.aprilReturn > baseAprilReturn) tags.push("4月改善");
  if (row.aprilLossTrades !== null && row.aprilLossTrades < baseAprilLossTrades) tags.push("4月亏损减少");
  if (metrics.maxDrawdown > baseMetrics.maxDrawdown) tags.push("回撤改善");
  if (metrics.totalReturn >= baseMetrics.totalReturn * 0.85) tags.push("收益保留");
  if (metrics.trades < baseMetrics.trades * 0.65) tags.push("交易过少");
  if (metrics.totalReturn < baseMetrics.totalReturn * 0.7) tags.push("过度熔断");
  return tags.length ? tags : ["变化有限"];
}

function diagnoseMarketBreadthRow(row: MarketBreadthComparisonRow, baseline: BacktestResult | null) {
  const metrics = row.result?.split.test.metrics;
  const baseMetrics = baseline?.split.test.metrics;
  const baseAprilReturn = monthReturn(baseline, "2026-04");
  const baseAprilLossTrades = monthLossTrades(baseline, "2026-04");
  const breakdown = row.result?.split.test.directionBreakdown;
  const tags: string[] = [];
  if (!metrics || !baseMetrics) return ["样本不足"];
  if (row.aprilReturn !== null && baseAprilReturn !== null && row.aprilReturn > baseAprilReturn) tags.push("4月改善");
  if (row.aprilLossTrades !== null && baseAprilLossTrades !== null && row.aprilLossTrades < baseAprilLossTrades) tags.push("4月亏损减少");
  if (metrics.maxDrawdown > baseMetrics.maxDrawdown) tags.push("回撤改善");
  if (metrics.totalReturn >= baseMetrics.totalReturn * 0.85) tags.push("收益保留");
  if (breakdown && breakdown.long.totalReturn > 0 && breakdown.short.totalReturn > 0) tags.push("多空均衡");
  if (metrics.trades < baseMetrics.trades * 0.6) tags.push("交易过少");
  if (metrics.totalReturn < baseMetrics.totalReturn * 0.7) tags.push("过度过滤");
  return tags.length ? tags : ["变化有限"];
}

function scoreMarketBreadthRow(result: BacktestResult | null, baseline: BacktestResult | null, aprilReturn: number | null) {
  const metrics = result?.split.test.metrics;
  const baseMetrics = baseline?.split.test.metrics;
  if (!metrics || !baseMetrics) return Number.NEGATIVE_INFINITY;
  const tradeRetention = baseMetrics.trades > 0 ? metrics.trades / baseMetrics.trades : 0;
  const returnRetention = baseMetrics.totalReturn > 0 ? metrics.totalReturn / baseMetrics.totalReturn : 0;
  const tradePenalty = tradeRetention < 0.6 ? (0.6 - tradeRetention) * 260 : 0;
  const returnPenalty = returnRetention < 0.85 ? (0.85 - returnRetention) * 220 : 0;
  const robustBonus = metrics.totalReturn >= baseMetrics.totalReturn * 0.85 && metrics.profitFactor > baseMetrics.profitFactor && metrics.maxDrawdown > baseMetrics.maxDrawdown && metrics.trades >= baseMetrics.trades * 0.6 ? 90 : 0;
  return metrics.totalReturn * 240 + metrics.profitFactor * 38 - Math.abs(metrics.maxDrawdown) * 70 + (aprilReturn ?? 0) * 150 + tradeRetention * 28 + robustBonus - tradePenalty - returnPenalty;
}

function MarketBreadthComparison({ rows, loading, progress, lockedCandidate, lockedBreadthCandidate, onRun, onLock }: { rows: MarketBreadthComparisonRow[]; loading: boolean; progress: string | null; lockedCandidate: LockedHigherTimeframeCandidate | null; lockedBreadthCandidate: LockedMarketBreadthCandidate | null; onRun: () => void; onLock: (row: MarketBreadthComparisonRow) => void }) {
  const candidateLabel = lockedCandidateLabel(lockedCandidate);
  const breadthLabel = lockedMarketBreadthLabel(lockedBreadthCandidate);
  const best = rows[0];
  const bestMetrics = best?.result?.split.test.metrics;

  return (
    <section style={{ backgroundColor: "var(--color-bg-card)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
        <div>
          <div style={{ fontSize: "13px", color: "var(--color-text-primary)", fontWeight: 600 }}>市场广度择时过滤参数对照</div>
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "4px" }}>参考主流合约池的广度状态：多数标的在 SMA 上方且斜率向上只允许做多，多数在 SMA 下方且斜率向下只允许做空；中性环境可选择空仓或沿用当前过滤。</div>
        </div>
        <button onClick={onRun} disabled={loading} style={{ padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--color-border)", background: loading ? "rgba(26,115,232,0.14)" : "var(--color-bg-elevated)", color: loading ? "var(--color-btn-primary)" : "var(--color-text-primary)", cursor: loading ? "default" : "pointer" }}>
          {loading ? "对照中..." : "运行市场广度对照"}
        </button>
      </div>
      {candidateLabel && <div style={{ marginBottom: "10px", color: "var(--color-btn-primary)", fontSize: "12px" }}>锁定主候选：{candidateLabel}</div>}
      {!candidateLabel && <div style={{ marginBottom: "10px", color: "#ffaa00", fontSize: "12px" }}>尚未锁定主候选。请先锁定高周期过滤候选。</div>}
      {breadthLabel && <div style={{ marginBottom: "10px", color: "var(--color-long)", fontSize: "12px" }}>锁定市场广度候选：{breadthLabel}</div>}
      {bestMetrics && <div style={{ marginBottom: "10px", color: "var(--color-long)", fontSize: "12px" }}>当前稳健第一名：{best.breadthTimeframe} / SMA{best.breadthSmaPeriod} / 阈值 {pct(best.threshold)} / {best.breadthNeutralMode === "block_all" ? "中性空仓" : "中性沿用原过滤"}，收益 {pct(bestMetrics.totalReturn)}，PF {num(bestMetrics.profitFactor)}，4月 {best.aprilReturn === null ? "--" : pct(best.aprilReturn)}。</div>}
      {progress && <div style={{ marginBottom: "10px", color: loading ? "var(--color-btn-primary)" : "var(--color-text-secondary)", fontSize: "12px" }}>{progress}</div>}
      <div style={{ marginBottom: "10px", color: "var(--color-text-secondary)", fontSize: "12px" }}>提示：该功能依赖本地多标的历史数据。建议先补充 OKX 的 BTC_USDT, ETH_USDT, SOL_USDT, BNB_USDT, XRP_USDT, DOGE_USDT, AVAX_USDT, LINK_USDT，周期至少包含 1h。</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", color: "var(--color-text-secondary)" }}>
          <thead><tr style={{ color: "var(--color-text-primary)", textAlign: "left" }}><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>排名</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>广度参数</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>标的池</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>收益</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>PF</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>回撤</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>交易数</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>4月收益</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>4月亏损</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>3月/6月</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>多/空</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>标签</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>操作</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={13} style={{ padding: "12px", textAlign: "center" }}>点击“运行市场广度对照”开始扫描 72 组参数。</td></tr>}
            {rows.map((row, index) => {
              const metrics = row.result?.split.test.metrics;
              const breakdown = row.result?.split.test.directionBreakdown;
              return <tr key={`${row.symbols.join("-")}-${row.breadthTimeframe}-${row.breadthSmaPeriod}-${row.threshold}-${row.breadthNeutralMode}`}><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: "var(--color-text-primary)", fontWeight: 600 }}>#{index + 1}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", fontFamily: "var(--font-mono)" }}>{row.breadthTimeframe} / SMA{row.breadthSmaPeriod} / ≥{pct(row.threshold)} / {row.breadthNeutralMode === "block_all" ? "中性空仓" : "中性沿用"}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{row.symbols.length}个</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: metrics && metrics.totalReturn >= 0 ? "var(--color-long)" : "var(--color-short)" }}>{metrics ? pct(metrics.totalReturn) : "--"}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: metrics && metrics.profitFactor >= 1 ? "var(--color-long)" : "#ffaa00" }}>{metrics ? num(metrics.profitFactor) : "--"}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{metrics ? pct(metrics.maxDrawdown) : "--"}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{metrics ? metrics.trades : "--"}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: row.aprilReturn !== null && row.aprilReturn >= 0 ? "var(--color-long)" : "var(--color-short)" }}>{row.aprilReturn === null ? "--" : pct(row.aprilReturn)}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{row.aprilLossTrades ?? "--"}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", fontFamily: "var(--font-mono)" }}>{row.marchReturn === null ? "--" : pct(row.marchReturn)} / {row.juneReturn === null ? "--" : pct(row.juneReturn)}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", fontFamily: "var(--font-mono)" }}>{breakdown ? `${pct(breakdown.long.totalReturn)} / ${pct(breakdown.short.totalReturn)}` : "--"}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: row.tags.includes("4月改善") || row.tags.includes("多空均衡") ? "var(--color-long)" : "#ffaa00" }}>{row.tags.join(" / ") || row.error || "--"}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}><button onClick={() => onLock(row)} disabled={!row.result} style={{ padding: "5px 8px", borderRadius: "6px", border: "1px solid var(--color-border)", background: "var(--color-bg-elevated)", color: "var(--color-text-primary)", cursor: row.result ? "pointer" : "default", whiteSpace: "nowrap" }}>锁定</button></td></tr>;
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function StopLossCircuitComparison({ rows, loading, progress, lockedCandidate, onRun }: { rows: StopLossCircuitComparisonRow[]; loading: boolean; progress: string | null; lockedCandidate: LockedHigherTimeframeCandidate | null; onRun: () => void }) {
  const candidateLabel = lockedCandidateLabel(lockedCandidate);
  const best = rows[0];
  const bestMetrics = best?.result?.split.test.metrics;

  return (
    <section style={{ backgroundColor: "var(--color-bg-card)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
        <div>
          <div style={{ fontSize: "13px", color: "var(--color-text-primary)", fontWeight: 600 }}>连续止损熔断参数对照</div>
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "4px" }}>只统计固定止损。当最近 N 笔交易内固定止损次数达到阈值时暂停开仓 M 根K线，用于缓解 4 月假突破连续止损。</div>
        </div>
        <button onClick={onRun} disabled={loading} style={{ padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--color-border)", background: loading ? "rgba(26,115,232,0.14)" : "var(--color-bg-elevated)", color: loading ? "var(--color-btn-primary)" : "var(--color-text-primary)", cursor: loading ? "default" : "pointer" }}>
          {loading ? "对照中..." : "运行止损熔断对照"}
        </button>
      </div>
      {candidateLabel && <div style={{ marginBottom: "10px", color: "var(--color-btn-primary)", fontSize: "12px" }}>锁定候选：{candidateLabel}</div>}
      {!candidateLabel && <div style={{ marginBottom: "10px", color: "#ffaa00", fontSize: "12px" }}>尚未锁定候选。请先锁定高周期过滤候选。</div>}
      {bestMetrics && <div style={{ marginBottom: "10px", color: "var(--color-long)", fontSize: "12px" }}>当前第一名：最近 {best.lookbackTrades} 笔内固定止损 ≥ {best.minStops} 次，熔断 {best.cooldownBars} 根K线；收益 {pct(bestMetrics.totalReturn)}，PF {num(bestMetrics.profitFactor)}，4月 {best.aprilReturn === null ? "--" : pct(best.aprilReturn)}。</div>}
      {progress && <div style={{ marginBottom: "10px", color: loading ? "var(--color-btn-primary)" : "var(--color-text-secondary)", fontSize: "12px" }}>{progress}</div>}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", color: "var(--color-text-secondary)" }}>
          <thead><tr style={{ color: "var(--color-text-primary)", textAlign: "left" }}><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>排名</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>熔断参数</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>收益</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>PF</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>回撤</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>交易数</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>4月收益</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>4月亏损</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>3月/6月</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>标签</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={10} style={{ padding: "12px", textAlign: "center" }}>点击“运行止损熔断对照”开始扫描 24 组参数。</td></tr>}
            {rows.map((row, index) => {
              const metrics = row.result?.split.test.metrics;
              return <tr key={`${row.lookbackTrades}-${row.minStops}-${row.cooldownBars}`}><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: "var(--color-text-primary)", fontWeight: 600 }}>#{index + 1}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", fontFamily: "var(--font-mono)" }}>近{row.lookbackTrades}笔 / 止损≥{row.minStops} / 暂停{row.cooldownBars}根</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: metrics && metrics.totalReturn >= 0 ? "var(--color-long)" : "var(--color-short)" }}>{metrics ? pct(metrics.totalReturn) : "--"}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: metrics && metrics.profitFactor >= 1 ? "var(--color-long)" : "#ffaa00" }}>{metrics ? num(metrics.profitFactor) : "--"}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{metrics ? pct(metrics.maxDrawdown) : "--"}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{metrics ? metrics.trades : "--"}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: row.aprilReturn !== null && row.aprilReturn >= 0 ? "var(--color-long)" : "var(--color-short)" }}>{row.aprilReturn === null ? "--" : pct(row.aprilReturn)}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{row.aprilLossTrades ?? "--"}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", fontFamily: "var(--font-mono)" }}>{row.marchReturn === null ? "--" : pct(row.marchReturn)} / {row.juneReturn === null ? "--" : pct(row.juneReturn)}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: row.tags.includes("4月改善") || row.tags.includes("回撤改善") ? "var(--color-long)" : "#ffaa00" }}>{row.tags.join(" / ") || row.error || "--"}</td></tr>;
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TrendQualityComparison({ rows, loading, progress, lockedCandidate, onRun }: { rows: TrendQualityComparisonRow[]; loading: boolean; progress: string | null; baseline: BacktestResult | null; lockedCandidate: LockedHigherTimeframeCandidate | null; onRun: () => void }) {
  const candidateLabel = lockedCandidateLabel(lockedCandidate);
  const best = rows[0];
  const bestMetrics = best?.result?.split.test.metrics;

  return (
    <section style={{ backgroundColor: "var(--color-bg-card)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
        <div>
          <div style={{ fontSize: "13px", color: "var(--color-text-primary)", fontWeight: 600 }}>趋势质量过滤参数对照</div>
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "4px" }}>基于锁定候选扫描慢均线距离阈值和 ATR% 下限，观察是否能降低 4 月假突破亏损，同时保留 3 月/6 月趋势收益。</div>
        </div>
        <button onClick={onRun} disabled={loading} style={{ padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--color-border)", background: loading ? "rgba(26,115,232,0.14)" : "var(--color-bg-elevated)", color: loading ? "var(--color-btn-primary)" : "var(--color-text-primary)", cursor: loading ? "default" : "pointer" }}>
          {loading ? "对照中..." : "运行趋势质量对照"}
        </button>
      </div>
      {candidateLabel && <div style={{ marginBottom: "10px", color: "var(--color-btn-primary)", fontSize: "12px" }}>锁定候选：{candidateLabel}</div>}
      {!candidateLabel && <div style={{ marginBottom: "10px", color: "#ffaa00", fontSize: "12px" }}>尚未锁定候选。请先锁定高周期过滤候选。</div>}
      {bestMetrics && <div style={{ marginBottom: "10px", color: "var(--color-long)", fontSize: "12px" }}>当前第一名：均线距离 ≥ {pct(best.minSlowSmaDistancePct)} / ATR ≥ {pct(best.minAtrPct)}，收益 {pct(bestMetrics.totalReturn)}，PF {num(bestMetrics.profitFactor)}，4月 {best.aprilReturn === null ? "--" : pct(best.aprilReturn)}。</div>}
      {progress && <div style={{ marginBottom: "10px", color: loading ? "var(--color-btn-primary)" : "var(--color-text-secondary)", fontSize: "12px" }}>{progress}</div>}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", color: "var(--color-text-secondary)" }}>
          <thead><tr style={{ color: "var(--color-text-primary)", textAlign: "left" }}><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>排名</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>过滤参数</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>收益</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>PF</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>回撤</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>交易数</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>4月收益</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>4月亏损</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>3月/6月</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>标签</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={10} style={{ padding: "12px", textAlign: "center" }}>点击“运行趋势质量对照”开始扫描 12 组参数。</td></tr>}
            {rows.map((row, index) => {
              const metrics = row.result?.split.test.metrics;
              return <tr key={`${row.minSlowSmaDistancePct}-${row.minAtrPct}`}><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: "var(--color-text-primary)", fontWeight: 600 }}>#{index + 1}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", fontFamily: "var(--font-mono)" }}>距均线≥{pct(row.minSlowSmaDistancePct)} / ATR≥{pct(row.minAtrPct)}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: metrics && metrics.totalReturn >= 0 ? "var(--color-long)" : "var(--color-short)" }}>{metrics ? pct(metrics.totalReturn) : "--"}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: metrics && metrics.profitFactor >= 1 ? "var(--color-long)" : "#ffaa00" }}>{metrics ? num(metrics.profitFactor) : "--"}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{metrics ? pct(metrics.maxDrawdown) : "--"}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{metrics ? metrics.trades : "--"}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: row.aprilReturn !== null && row.aprilReturn >= 0 ? "var(--color-long)" : "var(--color-short)" }}>{row.aprilReturn === null ? "--" : pct(row.aprilReturn)}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{row.aprilLossTrades ?? "--"}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", fontFamily: "var(--font-mono)" }}>{row.marchReturn === null ? "--" : pct(row.marchReturn)} / {row.juneReturn === null ? "--" : pct(row.juneReturn)}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: row.tags.includes("PF改善") || row.tags.includes("4月亏损收窄") ? "var(--color-long)" : "#ffaa00" }}>{row.tags.join(" / ") || row.error || "--"}</td></tr>;
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function LossZoneDiagnosticsPanel({ diagnostics, loading, progress, lockedCandidate, onRun }: { diagnostics: LossZoneDiagnostics | null; loading: boolean; progress: string | null; lockedCandidate: LockedHigherTimeframeCandidate | null; onRun: () => void }) {
  const candidateLabel = lockedCandidateLabel(lockedCandidate);
  const worstMonthState = diagnostics?.monthStates.find((row) => row.month === diagnostics.worstLossMonth);

  return (
    <section style={{ backgroundColor: "var(--color-bg-card)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
        <div>
          <div style={{ fontSize: "13px", color: "var(--color-text-primary)", fontWeight: 600 }}>主候选亏损区间诊断</div>
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "4px" }}>拆解亏损交易、月度波动率、K线实体占比和均线距离，用于识别 4 月这类低质量信号环境。</div>
        </div>
        <button onClick={onRun} disabled={loading} style={{ padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--color-border)", background: loading ? "rgba(26,115,232,0.14)" : "var(--color-bg-elevated)", color: loading ? "var(--color-btn-primary)" : "var(--color-text-primary)", cursor: loading ? "default" : "pointer" }}>
          {loading ? "诊断中..." : "运行亏损区间诊断"}
        </button>
      </div>
      {candidateLabel && <div style={{ marginBottom: "10px", color: "var(--color-btn-primary)", fontSize: "12px" }}>锁定候选：{candidateLabel}</div>}
      {!candidateLabel && <div style={{ marginBottom: "10px", color: "#ffaa00", fontSize: "12px" }}>尚未锁定候选。请先锁定高周期过滤候选。</div>}
      {progress && <div style={{ marginBottom: "10px", color: loading ? "var(--color-btn-primary)" : "var(--color-text-secondary)", fontSize: "12px" }}>{progress}</div>}
      {worstMonthState && <div style={{ marginBottom: "10px", color: "#ffaa00", fontSize: "12px" }}>当前最弱月份：{worstMonthState.month}，收益 {pct(worstMonthState.totalReturn)}，亏损交易 {worstMonthState.lossTrades}/{worstMonthState.trades}，状态判断：{worstMonthState.falseBreakRisk}。</div>}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: "12px" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", color: "var(--color-text-secondary)" }}>
            <thead><tr style={{ color: "var(--color-text-primary)", textAlign: "left" }}><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>月份</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>收益</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>亏损/交易</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>ATR%</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>实体占比</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>均线距离</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>状态</th></tr></thead>
            <tbody>
              {!diagnostics?.monthStates.length && <tr><td colSpan={7} style={{ padding: "12px", textAlign: "center" }}>点击“运行亏损区间诊断”开始分析。</td></tr>}
              {diagnostics?.monthStates.map((row) => <tr key={row.month}><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: "var(--color-text-primary)", fontWeight: 600 }}>{row.month}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: row.totalReturn >= 0 ? "var(--color-long)" : "var(--color-short)" }}>{pct(row.totalReturn)}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{row.lossTrades}/{row.trades}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{pct(row.avgAtrPct)}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{pct(row.avgBodyRatio)}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{pct(row.avgDistanceToSma)}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: row.falseBreakRisk.includes("趋势") ? "var(--color-long)" : "#ffaa00" }}>{row.falseBreakRisk}</td></tr>)}
            </tbody>
          </table>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", color: "var(--color-text-secondary)" }}>
            <thead><tr style={{ color: "var(--color-text-primary)", textAlign: "left" }}><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>方向</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>入场</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>出场</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>持仓h</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>收益</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>原因</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>ATR%</th></tr></thead>
            <tbody>
              {!diagnostics?.lossTrades.length && <tr><td colSpan={7} style={{ padding: "12px", textAlign: "center" }}>暂无亏损交易。</td></tr>}
              {diagnostics?.lossTrades.map((trade) => <tr key={`${trade.entryTime}-${trade.exitTime}-${trade.side}`}><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: trade.side === "long" ? "var(--color-long)" : "var(--color-short)", fontWeight: 600 }}>{trade.side === "long" ? "做多" : "做空"}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{fmtTime(trade.entryTime)}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{fmtTime(trade.exitTime)}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{num(trade.holdHours)}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: "var(--color-short)" }}>{pct(trade.pnlPct)}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{reasonText(trade.reason)}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{trade.atrPct === null ? "--" : pct(trade.atrPct)}</td></tr>)}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function CandidateDeepDiagnostics({ diagnostics, loading, progress, lockedCandidate, onRun }: { diagnostics: CandidateDiagnostics | null; loading: boolean; progress: string | null; lockedCandidate: LockedHigherTimeframeCandidate | null; onRun: () => void }) {
  const metrics = diagnostics?.result.split.test.metrics;
  const breakdown = diagnostics?.result.split.test.directionBreakdown;
  const candidateLabel = lockedCandidateLabel(lockedCandidate);

  return (
    <section style={{ backgroundColor: "var(--color-bg-card)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
        <div>
          <div style={{ fontSize: "13px", color: "var(--color-text-primary)", fontWeight: 600 }}>主候选细化验证</div>
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "4px" }}>基于已锁定候选，拆解月度收益、最大回撤区间、最长连亏、多空贡献和退出原因，用于判断策略是否可进入下一轮实盘模拟。</div>
        </div>
        <button onClick={onRun} disabled={loading} style={{ padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--color-border)", background: loading ? "rgba(26,115,232,0.14)" : "var(--color-bg-elevated)", color: loading ? "var(--color-btn-primary)" : "var(--color-text-primary)", cursor: loading ? "default" : "pointer" }}>
          {loading ? "分析中..." : "运行主候选细化验证"}
        </button>
      </div>
      {candidateLabel && <div style={{ marginBottom: "10px", color: "var(--color-btn-primary)", fontSize: "12px" }}>锁定候选：{candidateLabel}</div>}
      {!candidateLabel && <div style={{ marginBottom: "10px", color: "#ffaa00", fontSize: "12px" }}>尚未锁定候选。请先在“高周期过滤参数优化”中点击“一键应用当前第一名并锁定”。</div>}
      {progress && <div style={{ marginBottom: "10px", color: loading ? "var(--color-btn-primary)" : "var(--color-text-secondary)", fontSize: "12px" }}>{progress}</div>}
      {metrics && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(120px, 1fr))", gap: "10px", marginBottom: "12px" }}>
          <MetricCard label="测试段收益" value={pct(metrics.totalReturn)} hint={`PF ${num(metrics.profitFactor)} / 胜率 ${pct(metrics.winRate)}`} />
          <MetricCard label="最大回撤区间" value={diagnostics?.maxDrawdownRun ? pct(diagnostics.maxDrawdownRun.drawdown) : "--"} hint={diagnostics?.maxDrawdownRun ? `${fmtTime(diagnostics.maxDrawdownRun.startTime)} → ${fmtTime(diagnostics.maxDrawdownRun.endTime)}` : undefined} />
          <MetricCard label="最长连亏" value={diagnostics?.worstLossStreak ? `${diagnostics.worstLossStreak.count} 笔` : "0 笔"} hint={diagnostics?.worstLossStreak ? `累计 ${pct(diagnostics.worstLossStreak.totalReturn)}` : "无连续亏损"} />
          <MetricCard label="最佳/最差月份" value={`${diagnostics?.bestMonth ? pct(diagnostics.bestMonth.totalReturn) : "--"} / ${diagnostics?.worstMonth ? pct(diagnostics.worstMonth.totalReturn) : "--"}`} hint={`${diagnostics?.bestMonth?.month ?? "--"} / ${diagnostics?.worstMonth?.month ?? "--"}`} />
        </div>
      )}
      {breakdown && <div style={{ marginBottom: "12px", color: "var(--color-text-secondary)", fontSize: "12px" }}>多空贡献：做多 {pct(breakdown.long.totalReturn)} / PF {num(breakdown.long.profitFactor)} / {breakdown.long.trades} 笔；做空 {pct(breakdown.short.totalReturn)} / PF {num(breakdown.short.profitFactor)} / {breakdown.short.trades} 笔。</div>}
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "12px" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", color: "var(--color-text-secondary)" }}>
            <thead><tr style={{ color: "var(--color-text-primary)", textAlign: "left" }}><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>月份</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>收益</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>胜率</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>PF</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>交易数</th></tr></thead>
            <tbody>
              {!diagnostics?.monthly.length && <tr><td colSpan={5} style={{ padding: "12px", textAlign: "center", color: "var(--color-text-secondary)" }}>点击“运行主候选细化验证”开始拆解。</td></tr>}
              {diagnostics?.monthly.map((row) => <tr key={row.month}><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: "var(--color-text-primary)", fontWeight: 600 }}>{row.month}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: row.totalReturn >= 0 ? "var(--color-long)" : "var(--color-short)" }}>{pct(row.totalReturn)}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{pct(row.winRate)}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: row.profitFactor >= 1 ? "var(--color-long)" : "#ffaa00" }}>{num(row.profitFactor)}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{row.trades}</td></tr>)}
            </tbody>
          </table>
        </div>
        <div style={{ backgroundColor: "rgba(255,255,255,0.03)", border: "1px solid var(--color-border)", borderRadius: "8px", padding: "10px", fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.7 }}>
          <div style={{ color: "var(--color-text-primary)", fontWeight: 600, marginBottom: "6px" }}>退出原因</div>
          {!diagnostics?.exitReasonRows.length && <div>暂无退出统计</div>}
          {diagnostics?.exitReasonRows.map((row) => <div key={row.reason}>{reasonText(row.reason)}：{row.count} 笔</div>)}
        </div>
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

function MarketBreadthWindowValidation({ rows, loading, progress, lockedCandidate, lockedBreadthCandidate, onRun }: { rows: MarketBreadthWindowRow[]; loading: boolean; progress: string | null; lockedCandidate: LockedHigherTimeframeCandidate | null; lockedBreadthCandidate: LockedMarketBreadthCandidate | null; onRun: () => void }) {
  const improved = rows.filter((row) => {
    const baseline = row.baseline?.split.test.metrics;
    const filtered = row.filtered?.split.test.metrics;
    return baseline && filtered && filtered.totalReturn > baseline.totalReturn && filtered.profitFactor >= baseline.profitFactor;
  }).length;
  const summary = rows.length ? `市场广度过滤在 ${improved} / ${rows.length} 个窗口中同时改善收益与 PF。` : "";
  const candidateLabel = lockedCandidateLabel(lockedCandidate);
  const breadthLabel = lockedMarketBreadthLabel(lockedBreadthCandidate);

  return (
    <section style={{ backgroundColor: "var(--color-bg-card)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
        <div><div style={{ fontSize: "13px", color: "var(--color-text-primary)", fontWeight: 600 }}>市场广度分窗稳定性验证</div><div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "4px" }}>用已锁定市场广度候选，对比最近 90 / 180 / 270 / 360 天的原主候选与广度过滤后表现。</div></div>
        <button onClick={onRun} disabled={loading} style={{ padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--color-border)", background: loading ? "rgba(26,115,232,0.14)" : "var(--color-bg-elevated)", color: loading ? "var(--color-btn-primary)" : "var(--color-text-primary)", cursor: loading ? "default" : "pointer" }}>{loading ? "验证中..." : "运行广度分窗验证"}</button>
      </div>
      {candidateLabel && <div style={{ marginBottom: "8px", color: "var(--color-btn-primary)", fontSize: "12px" }}>主候选：{candidateLabel}</div>}
      {breadthLabel && <div style={{ marginBottom: "8px", color: "var(--color-long)", fontSize: "12px" }}>市场广度候选：{breadthLabel}</div>}
      {summary && <div style={{ marginBottom: "10px", color: improved >= Math.ceil(rows.length / 2) ? "var(--color-long)" : "#ffaa00", fontSize: "12px" }}>{summary}</div>}
      {progress && <div style={{ marginBottom: "10px", color: loading ? "var(--color-btn-primary)" : "var(--color-text-secondary)", fontSize: "12px" }}>{progress}</div>}
      <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", color: "var(--color-text-secondary)" }}><thead><tr style={{ color: "var(--color-text-primary)", textAlign: "left" }}><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>窗口</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>原收益</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>广度收益</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>原PF</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>广度PF</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>原回撤</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>广度回撤</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>交易数</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>诊断</th></tr></thead><tbody>{rows.length === 0 && <tr><td colSpan={9} style={{ padding: "12px", textAlign: "center" }}>锁定市场广度候选后运行分窗验证。</td></tr>}{rows.map((row) => { const baseline = row.baseline?.split.test.metrics; const filtered = row.filtered?.split.test.metrics; const ok = baseline && filtered && filtered.totalReturn > baseline.totalReturn && filtered.profitFactor >= baseline.profitFactor; return <tr key={row.windowDays}><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: "var(--color-text-primary)", fontWeight: 600 }}>{row.windowDays}天</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{baseline ? pct(baseline.totalReturn) : "--"}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: filtered && filtered.totalReturn >= 0 ? "var(--color-long)" : "var(--color-short)" }}>{filtered ? pct(filtered.totalReturn) : "--"}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{baseline ? num(baseline.profitFactor) : "--"}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: filtered && filtered.profitFactor >= 1 ? "var(--color-long)" : "#ffaa00" }}>{filtered ? num(filtered.profitFactor) : "--"}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{baseline ? pct(baseline.maxDrawdown) : "--"}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{filtered ? pct(filtered.maxDrawdown) : "--"}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{baseline && filtered ? `${baseline.trades} → ${filtered.trades}` : "--"}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: ok ? "var(--color-long)" : "#ffaa00" }}>{row.error ?? (ok ? "同时改善" : "未同时改善")}</td></tr>; })}</tbody></table></div>
    </section>
  );
}

function MarketBreadthConservativeValidation({ rows, loading, progress, lockedCandidate, lockedBreadthCandidate, onRun }: { rows: MarketBreadthConservativeRow[]; loading: boolean; progress: string | null; lockedCandidate: LockedHigherTimeframeCandidate | null; lockedBreadthCandidate: LockedMarketBreadthCandidate | null; onRun: () => void }) {
  const candidateLabel = lockedCandidateLabel(lockedCandidate);
  const breadthLabel = lockedMarketBreadthLabel(lockedBreadthCandidate);
  const conservative = rows.find((row) => row.mode === "conservative")?.result?.split.test.metrics;
  const passed = !!conservative && conservative.totalReturn > 0 && conservative.profitFactor > 1.2 && conservative.maxDrawdown > -0.08 && conservative.trades >= 6;
  return (
    <section style={{ backgroundColor: "var(--color-bg-card)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", marginBottom: "12px" }}><div><div style={{ fontSize: "13px", color: "var(--color-text-primary)", fontWeight: 600 }}>市场广度保守回测验证</div><div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "4px" }}>对锁定市场广度候选执行普通模式与保守模式对照，检查延迟入场和同K线冲突优先止损后是否仍正期望。</div></div><button onClick={onRun} disabled={loading} style={{ padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--color-border)", background: loading ? "rgba(26,115,232,0.14)" : "var(--color-bg-elevated)", color: loading ? "var(--color-btn-primary)" : "var(--color-text-primary)", cursor: loading ? "default" : "pointer" }}>{loading ? "验证中..." : "运行广度保守验证"}</button></div>
      {candidateLabel && <div style={{ marginBottom: "8px", color: "var(--color-btn-primary)", fontSize: "12px" }}>主候选：{candidateLabel}</div>}
      {breadthLabel && <div style={{ marginBottom: "8px", color: "var(--color-long)", fontSize: "12px" }}>市场广度候选：{breadthLabel}</div>}
      {rows.length > 0 && <div style={{ marginBottom: "10px", color: passed ? "var(--color-long)" : "#ffaa00", fontSize: "12px" }}>{passed ? "市场广度候选保守验证通过。" : "市场广度候选保守验证未完全通过，需检查收益/PF/回撤/交易数。"}</div>}
      {progress && <div style={{ marginBottom: "10px", color: loading ? "var(--color-btn-primary)" : "var(--color-text-secondary)", fontSize: "12px" }}>{progress}</div>}
      <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", color: "var(--color-text-secondary)" }}><thead><tr style={{ color: "var(--color-text-primary)", textAlign: "left" }}><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>模式</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>收益</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>胜率</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>PF</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>回撤</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>交易数</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>多空拆分</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>诊断</th></tr></thead><tbody>{rows.length === 0 && <tr><td colSpan={8} style={{ padding: "12px", textAlign: "center" }}>锁定市场广度候选后运行保守验证。</td></tr>}{rows.map((row) => { const metrics = row.result?.split.test.metrics; const breakdown = row.result?.split.test.directionBreakdown; const ok = metrics && metrics.totalReturn > 0 && metrics.profitFactor > 1; return <tr key={row.mode}><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: "var(--color-text-primary)", fontWeight: 600 }}>{row.label}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: metrics && metrics.totalReturn >= 0 ? "var(--color-long)" : "var(--color-short)" }}>{metrics ? pct(metrics.totalReturn) : "--"}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{metrics ? pct(metrics.winRate) : "--"}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: metrics && metrics.profitFactor >= 1 ? "var(--color-long)" : "#ffaa00" }}>{metrics ? num(metrics.profitFactor) : "--"}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{metrics ? pct(metrics.maxDrawdown) : "--"}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{metrics ? metrics.trades : "--"}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", fontFamily: "var(--font-mono)" }}>{breakdown ? `多 ${pct(breakdown.long.totalReturn)} / 空 ${pct(breakdown.short.totalReturn)}` : "--"}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: ok ? "var(--color-long)" : "#ffaa00" }}>{row.error ?? (ok ? "正期望" : "未通过")}</td></tr>; })}</tbody></table></div>
    </section>
  );
}

function MarketBreadthStateDiagnosticsPanel({ diagnostics, loading, progress, lockedCandidate, lockedBreadthCandidate, onRun }: { diagnostics: MarketBreadthStateDiagnostics | null; loading: boolean; progress: string | null; lockedCandidate: LockedHigherTimeframeCandidate | null; lockedBreadthCandidate: LockedMarketBreadthCandidate | null; onRun: () => void }) {
  const candidateLabel = lockedCandidateLabel(lockedCandidate);
  const breadthLabel = lockedMarketBreadthLabel(lockedBreadthCandidate);
  return (
    <section style={{ backgroundColor: "var(--color-bg-card)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", marginBottom: "12px" }}><div><div style={{ fontSize: "13px", color: "var(--color-text-primary)", fontWeight: 600 }}>市场广度状态贡献诊断</div><div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "4px" }}>拆解 bull / bear / neutral 状态下原策略交易、广度保留交易和被过滤交易收益，判断中性空仓是否真的过滤了亏损。</div></div><button onClick={onRun} disabled={loading} style={{ padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--color-border)", background: loading ? "rgba(26,115,232,0.14)" : "var(--color-bg-elevated)", color: loading ? "var(--color-btn-primary)" : "var(--color-text-primary)", cursor: loading ? "default" : "pointer" }}>{loading ? "诊断中..." : "运行广度状态诊断"}</button></div>
      {candidateLabel && <div style={{ marginBottom: "8px", color: "var(--color-btn-primary)", fontSize: "12px" }}>主候选：{candidateLabel}</div>}
      {breadthLabel && <div style={{ marginBottom: "8px", color: "var(--color-long)", fontSize: "12px" }}>市场广度候选：{breadthLabel}</div>}
      {progress && <div style={{ marginBottom: "10px", color: loading ? "var(--color-btn-primary)" : "var(--color-text-secondary)", fontSize: "12px" }}>{progress}</div>}
      <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", color: "var(--color-text-secondary)" }}><thead><tr style={{ color: "var(--color-text-primary)", textAlign: "left" }}><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>状态</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>原交易</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>原收益/PF</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>保留交易</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>保留收益/PF</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>被过滤交易</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>被过滤收益/PF</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>诊断</th></tr></thead><tbody>{!diagnostics && <tr><td colSpan={8} style={{ padding: "12px", textAlign: "center" }}>锁定市场广度候选后运行状态贡献诊断。</td></tr>}{diagnostics?.rows.map((row) => <tr key={row.bias}><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: "var(--color-text-primary)", fontWeight: 600 }}>{breadthBiasText(row.bias)}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{row.baseline.trades}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: row.baseline.totalReturn >= 0 ? "var(--color-long)" : "var(--color-short)", fontFamily: "var(--font-mono)" }}>{pct(row.baseline.totalReturn)} / {num(row.baseline.profitFactor)}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{row.kept.trades}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: row.kept.totalReturn >= 0 ? "var(--color-long)" : "var(--color-short)", fontFamily: "var(--font-mono)" }}>{pct(row.kept.totalReturn)} / {num(row.kept.profitFactor)}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{row.filtered.trades}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: row.filtered.totalReturn >= 0 ? "var(--color-long)" : "var(--color-short)", fontFamily: "var(--font-mono)" }}>{pct(row.filtered.totalReturn)} / {num(row.filtered.profitFactor)}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: row.diagnosis.includes("有效") || row.diagnosis.includes("健康") ? "var(--color-long)" : "#ffaa00" }}>{row.diagnosis}</td></tr>)}</tbody></table></div>
    </section>
  );
}

function MarketBreadthCoverageDiagnosticsPanel({ diagnostics, loading, progress, lockedCandidate, lockedBreadthCandidate, onRun }: { diagnostics: MarketBreadthCoverageDiagnostics | null; loading: boolean; progress: string | null; lockedCandidate: LockedHigherTimeframeCandidate | null; lockedBreadthCandidate: LockedMarketBreadthCandidate | null; onRun: () => void }) {
  const candidateLabel = lockedCandidateLabel(lockedCandidate);
  const breadthLabel = lockedMarketBreadthLabel(lockedBreadthCandidate);
  const data = diagnostics?.diagnostics;
  const stateTotal = data ? data.stateCounts.bull + data.stateCounts.bear + data.stateCounts.neutral : 0;
  return (
    <section style={{ backgroundColor: "var(--color-bg-card)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", marginBottom: "12px" }}><div><div style={{ fontSize: "13px", color: "var(--color-text-primary)", fontWeight: 600 }}>市场广度有效标的诊断</div><div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "4px" }}>检查锁定广度池里实际参与计算的标的数、可用高周期桶覆盖率和 bull / bear / neutral 状态占比，用来解释 4 标的池与 8 标的池是否实际等价。</div></div><button onClick={onRun} disabled={loading} style={{ padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--color-border)", background: loading ? "rgba(26,115,232,0.14)" : "var(--color-bg-elevated)", color: loading ? "var(--color-btn-primary)" : "var(--color-text-primary)", cursor: loading ? "default" : "pointer" }}>{loading ? "诊断中..." : "运行有效标的诊断"}</button></div>
      {candidateLabel && <div style={{ marginBottom: "8px", color: "var(--color-btn-primary)", fontSize: "12px" }}>主候选：{candidateLabel}</div>}
      {breadthLabel && <div style={{ marginBottom: "8px", color: "var(--color-long)", fontSize: "12px" }}>市场广度候选：{breadthLabel}</div>}
      {progress && <div style={{ marginBottom: "10px", color: loading ? "var(--color-btn-primary)" : "var(--color-text-secondary)", fontSize: "12px" }}>{progress}</div>}
      {data && <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(120px, 1fr))", gap: "10px", marginBottom: "12px" }}>
        <MetricCard label="请求/有效标的" value={`${data.requestedSymbols.length} / ${data.eligibleSymbols.length}`} hint={`最低要求 ${data.minRequiredSymbols} 个`} />
        <MetricCard label="平均有效标的" value={num(data.averageValidSymbols)} hint={`区间 ${data.minValidSymbols} - ${data.maxValidSymbols}`} />
        <MetricCard label="可用桶覆盖率" value={pct(data.coverageRatio)} hint={`${data.usableBucketCount} / ${data.bucketCount} 个高周期桶`} />
        <MetricCard label="平均多/空比例" value={`${pct(data.averageBullRatio)} / ${pct(data.averageBearRatio)}`} hint="按可用广度桶平均" />
      </div>}
      {data && <div style={{ marginBottom: "10px", color: diagnostics.conclusion.includes("等同") || diagnostics.conclusion.includes("不足") ? "#ffaa00" : "var(--color-long)", fontSize: "12px" }}>{diagnostics.conclusion}</div>}
      <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", color: "var(--color-text-secondary)" }}><thead><tr style={{ color: "var(--color-text-primary)", textAlign: "left" }}><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>项目</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>值</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>说明</th></tr></thead><tbody>{!data && <tr><td colSpan={3} style={{ padding: "12px", textAlign: "center" }}>锁定市场广度候选后运行有效标的诊断。</td></tr>}{data && <><tr><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: "var(--color-text-primary)", fontWeight: 600 }}>状态占比</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", fontFamily: "var(--font-mono)" }}>多 {stateTotal ? pct(data.stateCounts.bull / stateTotal) : "--"} / 空 {stateTotal ? pct(data.stateCounts.bear / stateTotal) : "--"} / 中性 {stateTotal ? pct(data.stateCounts.neutral / stateTotal) : "--"}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>按可计算广度桶统计，非按交易数统计。</td></tr>{data.symbolStats.map((item) => <tr key={item.symbol}><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: "var(--color-text-primary)", fontWeight: 600 }}>{item.symbol}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", fontFamily: "var(--font-mono)" }}>{item.rawCandles} 根 / {item.bucketCandles} 桶 / 可用 {item.usableBuckets} 桶</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: item.usableBuckets > 0 ? "var(--color-long)" : "#ffaa00" }}>{item.usableBuckets > 0 ? "参与广度计算" : "未参与有效广度计算，可能未补足历史"}</td></tr>)}</>}</tbody></table></div>
    </section>
  );
}

function MarketBreadthPoolCoverageComparison({ rows, loading, progress, lockedCandidate, lockedBreadthCandidate, onRun }: { rows: MarketBreadthPoolCoverageRow[]; loading: boolean; progress: string | null; lockedCandidate: LockedHigherTimeframeCandidate | null; lockedBreadthCandidate: LockedMarketBreadthCandidate | null; onRun: () => void }) {
  const candidateLabel = lockedCandidateLabel(lockedCandidate);
  const breadthLabel = lockedMarketBreadthLabel(lockedBreadthCandidate);
  const stateRatio = (data: MarketBreadthDiagnostics | undefined, state: "bull" | "bear" | "neutral") => {
    if (!data) return "--";
    const total = data.stateCounts.bull + data.stateCounts.bear + data.stateCounts.neutral;
    return total ? pct(data.stateCounts[state] / total) : "--";
  };
  return (
    <section style={{ backgroundColor: "var(--color-bg-card)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", marginBottom: "12px" }}><div><div style={{ fontSize: "13px", color: "var(--color-text-primary)", fontWeight: 600 }}>市场广度标的池覆盖对照</div><div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "4px" }}>固定已锁定的广度周期、SMA、阈值和中性模式，仅对比 4 标的池与 8 标的池是否真正提供额外市场信息。</div></div><button onClick={onRun} disabled={loading} style={{ padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--color-border)", background: loading ? "rgba(26,115,232,0.14)" : "var(--color-bg-elevated)", color: loading ? "var(--color-btn-primary)" : "var(--color-text-primary)", cursor: loading ? "default" : "pointer" }}>{loading ? "对照中..." : "运行标的池对照"}</button></div>
      {candidateLabel && <div style={{ marginBottom: "8px", color: "var(--color-btn-primary)", fontSize: "12px" }}>主候选：{candidateLabel}</div>}
      {breadthLabel && <div style={{ marginBottom: "8px", color: "var(--color-long)", fontSize: "12px" }}>当前广度参数：{breadthLabel}</div>}
      {progress && <div style={{ marginBottom: "10px", color: loading ? "var(--color-btn-primary)" : "var(--color-text-secondary)", fontSize: "12px" }}>{progress}</div>}
      <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", color: "var(--color-text-secondary)" }}><thead><tr style={{ color: "var(--color-text-primary)", textAlign: "left" }}><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>标的池</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>请求/有效</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>平均有效</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>覆盖率</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>状态占比</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>收益/PF</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>回撤/交易</th><th style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>诊断</th></tr></thead><tbody>{rows.length === 0 && <tr><td colSpan={8} style={{ padding: "12px", textAlign: "center" }}>锁定市场广度候选后运行标的池覆盖对照。</td></tr>}{rows.map((row) => { const metrics = row.result?.split.test.metrics; const data = row.diagnostics; return <tr key={row.label}><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: "var(--color-text-primary)", fontWeight: 600 }}>{row.label}<div style={{ fontSize: "11px", color: "var(--color-text-secondary)", marginTop: "4px" }}>{row.symbols.join(" / ")}</div></td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", fontFamily: "var(--font-mono)" }}>{data ? `${data.requestedSymbols.length} / ${data.eligibleSymbols.length}` : "--"}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{data ? num(data.averageValidSymbols) : "--"}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)" }}>{data ? pct(data.coverageRatio) : "--"}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", fontFamily: "var(--font-mono)" }}>多 {stateRatio(data, "bull")} / 空 {stateRatio(data, "bear")} / 中 {stateRatio(data, "neutral")}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: metrics && metrics.totalReturn >= 0 ? "var(--color-long)" : "var(--color-short)", fontFamily: "var(--font-mono)" }}>{metrics ? `${pct(metrics.totalReturn)} / ${num(metrics.profitFactor)}` : "--"}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", fontFamily: "var(--font-mono)" }}>{metrics ? `${pct(metrics.maxDrawdown)} / ${metrics.trades}` : "--"}</td><td style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", color: row.conclusion.includes("未补足") || row.conclusion.includes("等同") ? "#ffaa00" : "var(--color-long)" }}>{row.error ?? row.conclusion}</td></tr>; })}</tbody></table></div>
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
  const [candidateDiagnosticsLoading, setCandidateDiagnosticsLoading] = useState(false);
  const [candidateDiagnostics, setCandidateDiagnostics] = useState<CandidateDiagnostics | null>(null);
  const [candidateDiagnosticsProgress, setCandidateDiagnosticsProgress] = useState<string | null>(null);
  const [lossZoneDiagnosticsLoading, setLossZoneDiagnosticsLoading] = useState(false);
  const [lossZoneDiagnostics, setLossZoneDiagnostics] = useState<LossZoneDiagnostics | null>(null);
  const [lossZoneDiagnosticsProgress, setLossZoneDiagnosticsProgress] = useState<string | null>(null);
  const [trendQualityLoading, setTrendQualityLoading] = useState(false);
  const [trendQualityRows, setTrendQualityRows] = useState<TrendQualityComparisonRow[]>([]);
  const [trendQualityBaseline, setTrendQualityBaseline] = useState<BacktestResult | null>(null);
  const [trendQualityProgress, setTrendQualityProgress] = useState<string | null>(null);
  const [stopLossCircuitLoading, setStopLossCircuitLoading] = useState(false);
  const [stopLossCircuitRows, setStopLossCircuitRows] = useState<StopLossCircuitComparisonRow[]>([]);
  const [stopLossCircuitProgress, setStopLossCircuitProgress] = useState<string | null>(null);
  const [marketBreadthLoading, setMarketBreadthLoading] = useState(false);
  const [marketBreadthRows, setMarketBreadthRows] = useState<MarketBreadthComparisonRow[]>([]);
  const [marketBreadthProgress, setMarketBreadthProgress] = useState<string | null>(null);
  const [lockedMarketBreadthCandidate, setLockedMarketBreadthCandidate] = useState<LockedMarketBreadthCandidate | null>(null);
  const [marketBreadthWindowLoading, setMarketBreadthWindowLoading] = useState(false);
  const [marketBreadthWindowRows, setMarketBreadthWindowRows] = useState<MarketBreadthWindowRow[]>([]);
  const [marketBreadthWindowProgress, setMarketBreadthWindowProgress] = useState<string | null>(null);
  const [marketBreadthConservativeLoading, setMarketBreadthConservativeLoading] = useState(false);
  const [marketBreadthConservativeRows, setMarketBreadthConservativeRows] = useState<MarketBreadthConservativeRow[]>([]);
  const [marketBreadthConservativeProgress, setMarketBreadthConservativeProgress] = useState<string | null>(null);
  const [marketBreadthStateLoading, setMarketBreadthStateLoading] = useState(false);
  const [marketBreadthStateDiagnostics, setMarketBreadthStateDiagnostics] = useState<MarketBreadthStateDiagnostics | null>(null);
  const [marketBreadthStateProgress, setMarketBreadthStateProgress] = useState<string | null>(null);
  const [marketBreadthCoverageLoading, setMarketBreadthCoverageLoading] = useState(false);
  const [marketBreadthCoverageDiagnostics, setMarketBreadthCoverageDiagnostics] = useState<MarketBreadthCoverageDiagnostics | null>(null);
  const [marketBreadthCoverageProgress, setMarketBreadthCoverageProgress] = useState<string | null>(null);
  const [marketBreadthPoolLoading, setMarketBreadthPoolLoading] = useState(false);
  const [marketBreadthPoolRows, setMarketBreadthPoolRows] = useState<MarketBreadthPoolCoverageRow[]>([]);
  const [marketBreadthPoolProgress, setMarketBreadthPoolProgress] = useState<string | null>(null);
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

  const runTrendQualityComparison = async () => {
    if (!lockedHigherTimeframeCandidate) {
      setTrendQualityRows([]);
      setTrendQualityProgress("请先在高周期过滤参数优化中锁定一个候选，再运行趋势质量对照。");
      return;
    }
    setTrendQualityLoading(true);
    setTrendQualityRows([]);
    setTrendQualityBaseline(null);
    setTrendQualityProgress("准备扫描 12 组趋势质量过滤参数...");
    const distanceValues = [0, 0.015, 0.02, 0.025];
    const atrValues = [0, 0.008, 0.01];
    const combinations = distanceValues.flatMap((distance) => atrValues.map((atr) => ({ distance, atr })));
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
      signalDelayBars: lockedHigherTimeframeCandidate.signalDelayBars,
      conservativeSameBarExit: lockedHigherTimeframeCandidate.conservativeSameBarExit,
    };
    const baseline = await runBacktest({ ...commonParams, minSlowSmaDistancePct: 0, minAtrPct: 0 });
    setTrendQualityBaseline(baseline);
    const rows: TrendQualityComparisonRow[] = [];
    for (let index = 0; index < combinations.length; index += 4) {
      const batch = combinations.slice(index, index + 4);
      setTrendQualityProgress(`正在扫描 ${Math.min(index + batch.length, combinations.length)} / ${combinations.length} 组趋势质量过滤参数...`);
      const batchRows = await Promise.all(batch.map(async (combo) => {
        const result = await runBacktest({ ...commonParams, minSlowSmaDistancePct: combo.distance, minAtrPct: combo.atr });
        const metrics = result?.split.test.metrics;
        const aprilReturn = monthReturn(result, "2026-04");
        const row: TrendQualityComparisonRow = {
          minSlowSmaDistancePct: combo.distance,
          minAtrPct: combo.atr,
          result,
          aprilReturn,
          aprilLossTrades: monthLossTrades(result, "2026-04"),
          marchReturn: monthReturn(result, "2026-03"),
          juneReturn: monthReturn(result, "2026-06"),
          score: metrics ? metrics.profitFactor * 40 + metrics.totalReturn * 120 + (aprilReturn ?? 0) * 80 - Math.abs(metrics.maxDrawdown) * 40 + metrics.trades * 0.1 : Number.NEGATIVE_INFINITY,
          tags: [],
          error: result ? undefined : "样本不足",
        };
        row.tags = diagnoseTrendQualityRow(row, baseline);
        return row;
      }));
      rows.push(...batchRows);
      setTrendQualityRows([...rows].sort((a, b) => b.score - a.score));
    }
    setTrendQualityRows([...rows].sort((a, b) => b.score - a.score));
    setTrendQualityProgress(`趋势质量过滤对照完成：已扫描 ${combinations.length} 组参数。`);
    setTrendQualityLoading(false);
  };

  const lockMarketBreadthCandidate = (row: MarketBreadthComparisonRow) => {
    const metrics = row.result?.split.test.metrics;
    setLockedMarketBreadthCandidate({
      symbols: row.symbols,
      breadthTimeframe: row.breadthTimeframe,
      breadthSmaPeriod: row.breadthSmaPeriod,
      threshold: row.threshold,
      breadthNeutralMode: row.breadthNeutralMode,
      source: metrics ? {
        totalReturn: metrics.totalReturn,
        profitFactor: metrics.profitFactor,
        maxDrawdown: metrics.maxDrawdown,
        trades: metrics.trades,
      } : undefined,
    });
    setMarketBreadthProgress(`已锁定市场广度候选：${row.breadthTimeframe} / SMA${row.breadthSmaPeriod} / 阈值${pct(row.threshold)} / ${row.breadthNeutralMode === "block_all" ? "中性空仓" : "中性沿用"}。`);
  };

  const marketBreadthBacktestParams = (overrides?: Partial<{ limit: number; signalDelayBars: number; conservativeSameBarExit: boolean; breadthSymbols: string[] }>) => {
    if (!lockedHigherTimeframeCandidate || !lockedMarketBreadthCandidate) return null;
    return {
      exchange: lockedHigherTimeframeCandidate.exchange,
      symbol: "ETH_USDT",
      interval: lockedHigherTimeframeCandidate.interval,
      limit: overrides?.limit,
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
      signalDelayBars: overrides?.signalDelayBars ?? lockedHigherTimeframeCandidate.signalDelayBars,
      conservativeSameBarExit: overrides?.conservativeSameBarExit ?? lockedHigherTimeframeCandidate.conservativeSameBarExit,
      useMarketBreadthFilter: true,
      breadthSymbols: overrides?.breadthSymbols ?? lockedMarketBreadthCandidate.symbols,
      breadthTimeframe: lockedMarketBreadthCandidate.breadthTimeframe,
      breadthSmaPeriod: lockedMarketBreadthCandidate.breadthSmaPeriod,
      breadthBullThreshold: lockedMarketBreadthCandidate.threshold,
      breadthBearThreshold: lockedMarketBreadthCandidate.threshold,
      breadthNeutralMode: lockedMarketBreadthCandidate.breadthNeutralMode,
    };
  };

  const runMarketBreadthComparison = async () => {
    if (!lockedHigherTimeframeCandidate) {
      setMarketBreadthRows([]);
      setMarketBreadthProgress("请先在高周期过滤参数优化中锁定一个候选，再运行市场广度对照。");
      return;
    }
    setMarketBreadthLoading(true);
    setMarketBreadthRows([]);
    setMarketBreadthProgress("准备扫描 72 组市场广度过滤参数...");
    const symbolPools = [
      ["BTC_USDT", "ETH_USDT", "SOL_USDT", "BNB_USDT"],
      ["BTC_USDT", "ETH_USDT", "SOL_USDT", "BNB_USDT", "XRP_USDT", "DOGE_USDT", "AVAX_USDT", "LINK_USDT"],
    ];
    const timeframeValues: HigherTimeframe[] = ["4h", "1d"];
    const smaValues = [20, 30, 50];
    const thresholdValues = [0.5, 0.55, 0.6];
    const neutralModes: BreadthNeutralMode[] = ["block_all", "allow_current_filter"];
    const combinations = symbolPools.flatMap((symbols) =>
      timeframeValues.flatMap((breadthTimeframe) =>
        smaValues.flatMap((breadthSmaPeriod) =>
          thresholdValues.flatMap((threshold) =>
            neutralModes.map((breadthNeutralMode) => ({ symbols, breadthTimeframe, breadthSmaPeriod, threshold, breadthNeutralMode }))
          )
        )
      )
    );
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
      signalDelayBars: lockedHigherTimeframeCandidate.signalDelayBars,
      conservativeSameBarExit: lockedHigherTimeframeCandidate.conservativeSameBarExit,
    };
    const baseline = await runBacktest({ ...commonParams, useMarketBreadthFilter: false });
    const rows: MarketBreadthComparisonRow[] = [];
    for (let index = 0; index < combinations.length; index += 4) {
      const batch = combinations.slice(index, index + 4);
      setMarketBreadthProgress(`正在扫描 ${Math.min(index + batch.length, combinations.length)} / ${combinations.length} 组市场广度参数...`);
      const batchRows = await Promise.all(batch.map(async (combo) => {
        const result = await runBacktest({
          ...commonParams,
          useMarketBreadthFilter: true,
          breadthSymbols: combo.symbols,
          breadthTimeframe: combo.breadthTimeframe,
          breadthSmaPeriod: combo.breadthSmaPeriod,
          breadthBullThreshold: combo.threshold,
          breadthBearThreshold: combo.threshold,
          breadthNeutralMode: combo.breadthNeutralMode,
        });
        const aprilReturn = monthReturn(result, "2026-04");
        const row: MarketBreadthComparisonRow = {
          ...combo,
          result,
          aprilReturn,
          aprilLossTrades: monthLossTrades(result, "2026-04"),
          marchReturn: monthReturn(result, "2026-03"),
          juneReturn: monthReturn(result, "2026-06"),
          score: scoreMarketBreadthRow(result, baseline, aprilReturn),
          tags: [],
          error: result ? undefined : "样本不足或广度标的未补数",
        };
        row.tags = diagnoseMarketBreadthRow(row, baseline);
        return row;
      }));
      rows.push(...batchRows);
      setMarketBreadthRows([...rows].sort((a, b) => b.score - a.score));
    }
    const sortedRows = [...rows].sort((a, b) => b.score - a.score);
    setMarketBreadthRows(sortedRows);
    if (sortedRows[0]) lockMarketBreadthCandidate(sortedRows[0]);
    setMarketBreadthProgress(`市场广度过滤对照完成：已扫描 ${combinations.length} 组参数。`);
    setMarketBreadthLoading(false);
  };

  const runMarketBreadthWindowValidation = async () => {
    if (!lockedHigherTimeframeCandidate || !lockedMarketBreadthCandidate) {
      setMarketBreadthWindowRows([]);
      setMarketBreadthWindowProgress("请先锁定高周期主候选和市场广度候选，再运行市场广度分窗验证。");
      return;
    }
    setMarketBreadthWindowLoading(true);
    setMarketBreadthWindowRows([]);
    setMarketBreadthWindowProgress("正在验证市场广度候选分窗稳定性...");
    const windows = [90, 180, 270, 360];
    const rows: MarketBreadthWindowRow[] = [];
    for (const windowDays of windows) {
      const limit = Math.max(300, windowDays * 24 + 120);
      const breadthParams = marketBreadthBacktestParams({ limit });
      if (!breadthParams) break;
      const baseline = await runBacktest({ ...breadthParams, useMarketBreadthFilter: false });
      const filtered = await runBacktest(breadthParams);
      rows.push({ windowDays, baseline, filtered, error: filtered ? undefined : "样本不足" });
      setMarketBreadthWindowRows([...rows]);
      setMarketBreadthWindowProgress(`已完成 ${rows.length} / ${windows.length} 个窗口的市场广度分窗验证...`);
    }
    setMarketBreadthWindowProgress("市场广度分窗稳定性验证完成。");
    setMarketBreadthWindowLoading(false);
  };

  const runMarketBreadthConservativeValidation = async () => {
    if (!lockedHigherTimeframeCandidate || !lockedMarketBreadthCandidate) {
      setMarketBreadthConservativeRows([]);
      setMarketBreadthConservativeProgress("请先锁定高周期主候选和市场广度候选，再运行市场广度保守验证。");
      return;
    }
    setMarketBreadthConservativeLoading(true);
    setMarketBreadthConservativeRows([]);
    setMarketBreadthConservativeProgress("正在运行市场广度普通/保守回测对照...");
    const modes: MarketBreadthConservativeRow[] = [
      { mode: "normal", label: "普通", signalDelayBars: 0, conservativeSameBarExit: false, result: null },
      { mode: "conservative", label: "保守", signalDelayBars: 1, conservativeSameBarExit: true, result: null },
    ];
    const rows: MarketBreadthConservativeRow[] = [];
    for (const mode of modes) {
      const params = marketBreadthBacktestParams({ signalDelayBars: mode.signalDelayBars, conservativeSameBarExit: mode.conservativeSameBarExit });
      const result = params ? await runBacktest(params) : null;
      rows.push({ ...mode, result, error: result ? undefined : "回测失败或样本不足" });
      setMarketBreadthConservativeRows([...rows]);
    }
    setMarketBreadthConservativeProgress("市场广度普通/保守回测对照完成。");
    setMarketBreadthConservativeLoading(false);
  };

  const diagnoseBreadthState = (bias: "bull" | "bear" | "neutral", baseline: ReturnType<typeof metricsFromTrades>, kept: ReturnType<typeof metricsFromTrades>, filtered: ReturnType<typeof metricsFromTrades>) => {
    if (filtered.trades === 0) return kept.trades > 0 ? "状态保留健康" : "该状态无样本";
    if (filtered.totalReturn < 0 && kept.totalReturn >= 0) return "过滤有效：剔除亏损交易";
    if (filtered.totalReturn > 0 && kept.totalReturn < baseline.totalReturn) return "过滤偏严：剔除盈利交易";
    if (bias === "neutral" && filtered.totalReturn < 0) return "中性空仓有效";
    return "需继续观察";
  };

  const diagnoseBreadthCoverage = (diagnostics: MarketBreadthDiagnostics) => {
    if (diagnostics.status === "insufficient_symbols" || diagnostics.eligibleSymbols.length < diagnostics.minRequiredSymbols) return `有效广度标的只有 ${diagnostics.eligibleSymbols.length} 个，低于最低要求 ${diagnostics.minRequiredSymbols} 个，当前广度判断可信度不足。`;
    if (diagnostics.eligibleSymbols.length < diagnostics.requestedSymbols.length) return `请求 ${diagnostics.requestedSymbols.length} 个标的，但实际只有 ${diagnostics.eligibleSymbols.length} 个满足历史长度要求；若 8 标的池结果接近 4 标的池，优先检查未参与标的是否未补足历史。`;
    if (diagnostics.averageValidSymbols < diagnostics.requestedSymbols.length * 0.8) return `虽然有 ${diagnostics.eligibleSymbols.length} 个标的满足总长度要求，但单个高周期桶平均只有 ${num(diagnostics.averageValidSymbols)} 个标的有效，部分标的覆盖不连续。`;
    return `广度池覆盖健康：${diagnostics.eligibleSymbols.length} 个标的均具备足够历史，平均每个高周期桶有 ${num(diagnostics.averageValidSymbols)} 个有效标的参与计算。`;
  };

  const runMarketBreadthCoverageDiagnostics = async () => {
    if (!lockedHigherTimeframeCandidate || !lockedMarketBreadthCandidate) {
      setMarketBreadthCoverageDiagnostics(null);
      setMarketBreadthCoverageProgress("请先锁定高周期主候选和市场广度候选，再运行有效标的诊断。");
      return;
    }
    setMarketBreadthCoverageLoading(true);
    setMarketBreadthCoverageDiagnostics(null);
    setMarketBreadthCoverageProgress("正在检查市场广度有效标的数与状态覆盖率...");
    const params = marketBreadthBacktestParams();
    const result = params ? await runBacktest(params) : null;
    const diagnostics = result?.split.test.marketBreadthDiagnostics;
    if (!result || !diagnostics) {
      setMarketBreadthCoverageProgress("市场广度有效标的诊断失败：样本不足或回测结果为空。");
      setMarketBreadthCoverageLoading(false);
      return;
    }
    setMarketBreadthCoverageDiagnostics({ result, diagnostics, conclusion: diagnoseBreadthCoverage(diagnostics) });
    setMarketBreadthCoverageProgress("市场广度有效标的诊断完成。");
    setMarketBreadthCoverageLoading(false);
  };

  const runMarketBreadthPoolCoverageComparison = async () => {
    if (!lockedHigherTimeframeCandidate || !lockedMarketBreadthCandidate) {
      setMarketBreadthPoolRows([]);
      setMarketBreadthPoolProgress("请先锁定高周期主候选和市场广度候选，再运行标的池覆盖对照。");
      return;
    }
    setMarketBreadthPoolLoading(true);
    setMarketBreadthPoolRows([]);
    setMarketBreadthPoolProgress("正在对比 4 标的池与 8 标的池...");
    const pools = [
      { label: "4标的池", symbols: ["BTC_USDT", "ETH_USDT", "SOL_USDT", "BNB_USDT"] },
      { label: "8标的池", symbols: ["BTC_USDT", "ETH_USDT", "SOL_USDT", "BNB_USDT", "XRP_USDT", "DOGE_USDT", "AVAX_USDT", "LINK_USDT"] },
    ];
    const rows: MarketBreadthPoolCoverageRow[] = [];
    for (const pool of pools) {
      setMarketBreadthPoolProgress(`正在运行${pool.label}覆盖对照...`);
      const params = marketBreadthBacktestParams({ breadthSymbols: pool.symbols });
      const result = params ? await runBacktest(params) : null;
      const diagnostics = result?.split.test.marketBreadthDiagnostics;
      rows.push({
        label: pool.label,
        symbols: pool.symbols,
        result,
        diagnostics,
        conclusion: diagnostics ? diagnoseBreadthCoverage(diagnostics) : "回测失败或缺少广度诊断",
        error: result && diagnostics ? undefined : "回测失败或缺少广度诊断",
      });
      setMarketBreadthPoolRows([...rows]);
    }
    const four = rows.find((row) => row.label === "4标的池");
    const eight = rows.find((row) => row.label === "8标的池");
    if (four?.diagnostics && eight?.diagnostics) {
      const fourMetrics = four.result?.split.test.metrics;
      const eightMetrics = eight.result?.split.test.metrics;
      const sameEffectiveCount = eight.diagnostics.eligibleSymbols.length <= four.diagnostics.eligibleSymbols.length;
      const closeReturn = !!fourMetrics && !!eightMetrics && Math.abs(fourMetrics.totalReturn - eightMetrics.totalReturn) < 0.001 && Math.abs(fourMetrics.profitFactor - eightMetrics.profitFactor) < 0.05;
      setMarketBreadthPoolProgress(sameEffectiveCount
        ? "标的池覆盖对照完成：8标的池没有增加有效标的，结果接近4标的池属于数据覆盖问题。"
        : closeReturn
          ? "标的池覆盖对照完成：8标的池有效标的更多，但结果接近4标的池，说明前4个标的已较好代表市场广度。"
          : "标的池覆盖对照完成：8标的池带来了不同结果，后续可比较是否值得替换4标的池。"
      );
    } else {
      setMarketBreadthPoolProgress("标的池覆盖对照完成，但部分结果缺少诊断数据。");
    }
    setMarketBreadthPoolLoading(false);
  };

  const runMarketBreadthStateDiagnostics = async () => {
    if (!lockedHigherTimeframeCandidate || !lockedMarketBreadthCandidate) {
      setMarketBreadthStateDiagnostics(null);
      setMarketBreadthStateProgress("请先锁定高周期主候选和市场广度候选，再运行市场广度状态诊断。");
      return;
    }
    setMarketBreadthStateLoading(true);
    setMarketBreadthStateDiagnostics(null);
    setMarketBreadthStateProgress("正在拆解市场广度状态贡献...");
    const params = marketBreadthBacktestParams();
    const result = params ? await runBacktest(params) : null;
    if (!result) {
      setMarketBreadthStateProgress("市场广度状态诊断失败：样本不足或回测结果为空。");
      setMarketBreadthStateLoading(false);
      return;
    }
    const actualTrades = result.split.test.trades ?? [];
    const candidateTrades = result.split.test.candidateTrades ?? [];
    const allTrades = [...actualTrades, ...candidateTrades];
    const biases: Array<"bull" | "bear" | "neutral"> = ["bull", "bear", "neutral"];
    const rows = biases.map((bias) => {
      const baselineTrades = allTrades.filter((trade) => trade.marketBreadthBias === bias);
      const keptTrades = actualTrades.filter((trade) => trade.marketBreadthBias === bias);
      const filteredTrades = candidateTrades.filter((trade) => trade.marketBreadthBias === bias && trade.filteredByMarketBreadth);
      const baseline = metricsFromTrades(baselineTrades);
      const kept = metricsFromTrades(keptTrades);
      const filtered = metricsFromTrades(filteredTrades);
      return { bias, baseline, kept, filtered, diagnosis: diagnoseBreadthState(bias, baseline, kept, filtered) };
    });
    setMarketBreadthStateDiagnostics({ result, rows });
    setMarketBreadthStateProgress("市场广度状态贡献诊断完成。");
    setMarketBreadthStateLoading(false);
  };

  const runStopLossCircuitComparison = async () => {
    if (!lockedHigherTimeframeCandidate) {
      setStopLossCircuitRows([]);
      setStopLossCircuitProgress("请先在高周期过滤参数优化中锁定一个候选，再运行连续止损熔断对照。");
      return;
    }
    setStopLossCircuitLoading(true);
    setStopLossCircuitRows([]);
    setStopLossCircuitProgress("准备扫描 24 组连续止损熔断参数...");
    const lookbackValues = [3, 4, 5];
    const minStopValues = [2, 3];
    const cooldownValues = [12, 24, 36, 48];
    const combinations = lookbackValues.flatMap((lookbackTrades) =>
      minStopValues.flatMap((minStops) =>
        cooldownValues.map((cooldownBars) => ({ lookbackTrades, minStops, cooldownBars }))
      )
    );
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
      signalDelayBars: lockedHigherTimeframeCandidate.signalDelayBars,
      conservativeSameBarExit: lockedHigherTimeframeCandidate.conservativeSameBarExit,
    };
    const baseline = await runBacktest({ ...commonParams, stopLossCircuitLookbackTrades: 0, stopLossCircuitMinStops: 0, stopLossCircuitCooldownBars: 0 });
    const rows: StopLossCircuitComparisonRow[] = [];
    for (let index = 0; index < combinations.length; index += 4) {
      const batch = combinations.slice(index, index + 4);
      setStopLossCircuitProgress(`正在扫描 ${Math.min(index + batch.length, combinations.length)} / ${combinations.length} 组连续止损熔断参数...`);
      const batchRows = await Promise.all(batch.map(async (combo) => {
        const result = await runBacktest({
          ...commonParams,
          stopLossCircuitLookbackTrades: combo.lookbackTrades,
          stopLossCircuitMinStops: combo.minStops,
          stopLossCircuitCooldownBars: combo.cooldownBars,
        });
        const metrics = result?.split.test.metrics;
        const aprilReturn = monthReturn(result, "2026-04");
        const row: StopLossCircuitComparisonRow = {
          ...combo,
          result,
          aprilReturn,
          aprilLossTrades: monthLossTrades(result, "2026-04"),
          marchReturn: monthReturn(result, "2026-03"),
          juneReturn: monthReturn(result, "2026-06"),
          score: metrics ? metrics.profitFactor * 45 + metrics.totalReturn * 160 + (aprilReturn ?? 0) * 120 - Math.abs(metrics.maxDrawdown) * 45 + metrics.trades * 0.08 : Number.NEGATIVE_INFINITY,
          tags: [],
          error: result ? undefined : "样本不足",
        };
        row.tags = diagnoseStopLossCircuitRow(row, baseline);
        return row;
      }));
      rows.push(...batchRows);
      setStopLossCircuitRows([...rows].sort((a, b) => b.score - a.score));
    }
    setStopLossCircuitRows([...rows].sort((a, b) => b.score - a.score));
    setStopLossCircuitProgress(`连续止损熔断对照完成：已扫描 ${combinations.length} 组参数。`);
    setStopLossCircuitLoading(false);
  };

  const runLossZoneDiagnostics = async () => {
    if (!lockedHigherTimeframeCandidate) {
      setLossZoneDiagnostics(null);
      setLossZoneDiagnosticsProgress("请先在高周期过滤参数优化中锁定一个候选，再运行亏损区间诊断。");
      return;
    }
    setLossZoneDiagnosticsLoading(true);
    setLossZoneDiagnostics(null);
    setLossZoneDiagnosticsProgress("正在拉取锁定候选回测结果和本地K线，拆解亏损环境...");
    const [result, local] = await Promise.all([
      runBacktest({
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
        signalDelayBars: lockedHigherTimeframeCandidate.signalDelayBars,
        conservativeSameBarExit: lockedHigherTimeframeCandidate.conservativeSameBarExit,
      }),
      getLocalCandles({ exchange: lockedHigherTimeframeCandidate.exchange, symbol: "ETH_USDT", interval: lockedHigherTimeframeCandidate.interval, limit: 10000 }),
    ]);
    if (!result || !local?.candles.length) {
      setLossZoneDiagnosticsProgress("亏损区间诊断失败：本地样本不足或回测结果为空。");
      setLossZoneDiagnosticsLoading(false);
      return;
    }
    setLossZoneDiagnostics(buildLossZoneDiagnostics(result, local.candles, lockedHigherTimeframeCandidate));
    setLossZoneDiagnosticsProgress("亏损区间诊断完成：已拆解亏损交易、月度波动率、实体占比和均线距离。");
    setLossZoneDiagnosticsLoading(false);
  };

  const runCandidateDeepDiagnostics = async () => {
    if (!lockedHigherTimeframeCandidate) {
      setCandidateDiagnostics(null);
      setCandidateDiagnosticsProgress("请先在高周期过滤参数优化中锁定一个候选，再运行主候选细化验证。");
      return;
    }
    setCandidateDiagnosticsLoading(true);
    setCandidateDiagnostics(null);
    setCandidateDiagnosticsProgress("正在使用锁定候选拉取完整测试段交易明细...");
    const result = await runBacktest({
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
      signalDelayBars: lockedHigherTimeframeCandidate.signalDelayBars,
      conservativeSameBarExit: lockedHigherTimeframeCandidate.conservativeSameBarExit,
    });
    if (!result) {
      setCandidateDiagnosticsProgress("主候选细化验证失败：本地样本不足或后端返回为空。");
      setCandidateDiagnosticsLoading(false);
      return;
    }
    setCandidateDiagnostics(analyzeCandidate(result));
    setCandidateDiagnosticsProgress("主候选细化验证完成：已拆解月度收益、回撤、连亏和退出原因。");
    setCandidateDiagnosticsLoading(false);
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
    setCandidateDiagnostics(null);
    setLossZoneDiagnostics(null);
    setTrendQualityRows([]);
    setStopLossCircuitRows([]);
    setHigherTimeframeWindowProgress("已锁定候选。请重新运行高周期分窗验证，结果将强制使用这组参数。");
    setConservativeValidationProgress("已锁定候选。请重新运行保守回测对照，结果将强制使用这组参数。");
    setCandidateDiagnosticsProgress("已锁定候选。请运行主候选细化验证，查看月度收益、回撤和连亏拆解。");
    setLossZoneDiagnosticsProgress("已锁定候选。请运行亏损区间诊断，识别低质量信号环境。");
    setTrendQualityProgress("已锁定候选。请运行趋势质量过滤对照，验证均线距离和ATR过滤效果。");
    setStopLossCircuitProgress("已锁定候选。请运行连续止损熔断对照，验证假突破连续止损后的动态冷却效果。");
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

      <CandidateDeepDiagnostics diagnostics={candidateDiagnostics} loading={candidateDiagnosticsLoading} progress={candidateDiagnosticsProgress} lockedCandidate={lockedHigherTimeframeCandidate} onRun={() => void runCandidateDeepDiagnostics()} />

      <LossZoneDiagnosticsPanel diagnostics={lossZoneDiagnostics} loading={lossZoneDiagnosticsLoading} progress={lossZoneDiagnosticsProgress} lockedCandidate={lockedHigherTimeframeCandidate} onRun={() => void runLossZoneDiagnostics()} />

      <TrendQualityComparison rows={trendQualityRows} loading={trendQualityLoading} progress={trendQualityProgress} baseline={trendQualityBaseline} lockedCandidate={lockedHigherTimeframeCandidate} onRun={() => void runTrendQualityComparison()} />

      <StopLossCircuitComparison rows={stopLossCircuitRows} loading={stopLossCircuitLoading} progress={stopLossCircuitProgress} lockedCandidate={lockedHigherTimeframeCandidate} onRun={() => void runStopLossCircuitComparison()} />

      <MarketBreadthComparison rows={marketBreadthRows} loading={marketBreadthLoading} progress={marketBreadthProgress} lockedCandidate={lockedHigherTimeframeCandidate} lockedBreadthCandidate={lockedMarketBreadthCandidate} onRun={() => void runMarketBreadthComparison()} onLock={lockMarketBreadthCandidate} />

      <MarketBreadthWindowValidation rows={marketBreadthWindowRows} loading={marketBreadthWindowLoading} progress={marketBreadthWindowProgress} lockedCandidate={lockedHigherTimeframeCandidate} lockedBreadthCandidate={lockedMarketBreadthCandidate} onRun={() => void runMarketBreadthWindowValidation()} />

      <MarketBreadthConservativeValidation rows={marketBreadthConservativeRows} loading={marketBreadthConservativeLoading} progress={marketBreadthConservativeProgress} lockedCandidate={lockedHigherTimeframeCandidate} lockedBreadthCandidate={lockedMarketBreadthCandidate} onRun={() => void runMarketBreadthConservativeValidation()} />

      <MarketBreadthStateDiagnosticsPanel diagnostics={marketBreadthStateDiagnostics} loading={marketBreadthStateLoading} progress={marketBreadthStateProgress} lockedCandidate={lockedHigherTimeframeCandidate} lockedBreadthCandidate={lockedMarketBreadthCandidate} onRun={() => void runMarketBreadthStateDiagnostics()} />

      <MarketBreadthCoverageDiagnosticsPanel diagnostics={marketBreadthCoverageDiagnostics} loading={marketBreadthCoverageLoading} progress={marketBreadthCoverageProgress} lockedCandidate={lockedHigherTimeframeCandidate} lockedBreadthCandidate={lockedMarketBreadthCandidate} onRun={() => void runMarketBreadthCoverageDiagnostics()} />

      <MarketBreadthPoolCoverageComparison rows={marketBreadthPoolRows} loading={marketBreadthPoolLoading} progress={marketBreadthPoolProgress} lockedCandidate={lockedHigherTimeframeCandidate} lockedBreadthCandidate={lockedMarketBreadthCandidate} onRun={() => void runMarketBreadthPoolCoverageComparison()} />

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
