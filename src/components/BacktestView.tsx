import { useCallback, useEffect, useState } from "react";
import { BarChart3, Database, RefreshCw } from "lucide-react";
import { useMarketStore, useStrategyStore } from "../store";
import { backfillLocalCandles, getBackfillJob, getLocalCandles, runBacktest, type BackfillJob, type BacktestMetrics, type BacktestResult, type CandleRange } from "../services/localDataApi";

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
  const { interval, historicalSource } = useMarketStore();
  const { strategy, fastPeriod, slowPeriod, rsiPeriod, longRsiMax, shortRsiMin, adxPeriod, minAdx, atrPeriod, atrStopMultiplier, atrTrailMultiplier, useTrailingStop, feeRate, slippageRate, cooldownBars, maxHoldBars, setParams } = useStrategyStore();
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [idealResult, setIdealResult] = useState<BacktestResult | null>(null);
  const [range, setRange] = useState<CandleRange | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const [backfilling, setBackfilling] = useState(false);
  const [periodComparing, setPeriodComparing] = useState(false);
  const [periodRows, setPeriodRows] = useState<PeriodComparisonRow[]>([]);
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
      const commonParams = { exchange: historicalSource, symbol: "ETH_USDT", interval, strategy: backtestStrategy, fastPeriod, slowPeriod, rsiPeriod, longRsiMax, shortRsiMin, adxPeriod, minAdx, atrPeriod, atrStopMultiplier, atrTrailMultiplier, useTrailingStop, feeRate, slippageRate, cooldownBars, maxHoldBars };
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
  }, [adxPeriod, atrPeriod, atrStopMultiplier, atrTrailMultiplier, cooldownBars, fastPeriod, feeRate, historicalSource, interval, longRsiMax, maxHoldBars, minAdx, rsiPeriod, shortRsiMin, slippageRate, slowPeriod, strategy, useTrailingStop]);

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
      const commonParams = { exchange: historicalSource, symbol: "ETH_USDT", interval: targetInterval, strategy: backtestStrategy, fastPeriod, slowPeriod, rsiPeriod, longRsiMax, shortRsiMin, adxPeriod, minAdx, atrPeriod, atrStopMultiplier, atrTrailMultiplier, useTrailingStop, feeRate, slippageRate, cooldownBars, maxHoldBars };
      const [real, ideal] = await Promise.all([
        runBacktest(commonParams),
        runBacktest({ ...commonParams, minAdx: 0, useTrailingStop: false, feeRate: 0, slippageRate: 0, cooldownBars: 0, maxHoldBars: 0 }),
      ]);
      return { interval: targetInterval, real, ideal, error: real ? undefined : "本地样本不足" };
    }));
    setPeriodRows(rows);
    setPeriodComparing(false);
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
          <ParamInput label="最小ADX" value={minAdx} onChange={(v) => setParams({ minAdx: v })} min={10} max={45} step={1} />
          <ParamInput label="ATR止损倍数" value={atrStopMultiplier} onChange={(v) => setParams({ atrStopMultiplier: v })} min={0.5} max={5} step={0.1} />
          <ParamInput label="ATR追踪倍数" value={atrTrailMultiplier} onChange={(v) => setParams({ atrTrailMultiplier: v })} min={0.5} max={6} step={0.1} />
          <ParamInput label="手续费率" value={feeRate} onChange={(v) => setParams({ feeRate: v })} min={0} max={0.005} step={0.0001} />
          <ParamInput label="滑点率" value={slippageRate} onChange={(v) => setParams({ slippageRate: v })} min={0} max={0.005} step={0.0001} />
          <ParamInput label="冷却K线" value={cooldownBars} onChange={(v) => setParams({ cooldownBars: v })} min={0} max={50} step={1} />
          <ParamInput label="最大持仓K线" value={maxHoldBars} onChange={(v) => setParams({ maxHoldBars: v })} min={0} max={500} step={1} />
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
