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

function MetricsGrid({ metrics }: { metrics: BacktestMetrics }) {
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
    </div>
  );
}

export default function BacktestView() {
  const { interval, historicalSource } = useMarketStore();
  const { strategy, fastPeriod, slowPeriod, rsiPeriod, longRsiMax, shortRsiMin } = useStrategyStore();
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [range, setRange] = useState<CandleRange | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const [backfilling, setBackfilling] = useState(false);
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
      const backtestStrategy = strategy === "sma_rsi_pullback" ? "sma_rsi_pullback" : "dual_ma";
      const data = await runBacktest({ exchange: historicalSource, symbol: "ETH_USDT", interval, strategy: backtestStrategy, fastPeriod, slowPeriod, rsiPeriod, longRsiMax, shortRsiMin });
      if (!data) {
        setResult(null);
        setValidationMessage(null);
        setError(`本地历史数据不足或后端未启动。当前历史源：${historicalSource.toUpperCase()}。长历史建议选择 OKX 后点击“补充历史数据”，或运行 npm run backfill -- --exchange okx --symbols ETH_USDT,BTC_USDT --intervals 15m,1h --days 180`);
      } else {
        setResult(data);
        setValidationMessage(`验证完成：${data.exchange?.toUpperCase() ?? historicalSource.toUpperCase()} / ${data.symbol} / ${data.interval} / ${data.strategy === "sma_rsi_pullback" ? "SMA+RSI" : "双均线"}，训练段 ${data.split.train.metrics.candles} 根，测试段 ${data.split.test.metrics.candles} 根。`);
      }
    } catch (err) {
      setResult(null);
      setValidationMessage(null);
      setError(`重新验证失败：${err instanceof Error ? err.message : "未知错误"}`);
    } finally {
      setLoading(false);
    }
  }, [fastPeriod, historicalSource, interval, longRsiMax, rsiPeriod, shortRsiMin, slowPeriod, strategy]);

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

      <div style={{ backgroundColor: "var(--color-bg-card)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "16px", display: "grid", gridTemplateColumns: "repeat(4, minmax(120px, 1fr))", gap: "10px", color: "var(--color-text-secondary)", fontSize: "12px" }}>
        <MetricCard label="历史数据源" value={historicalSource.toUpperCase()} />
        <MetricCard label="回测策略" value={strategy === "sma_rsi_pullback" ? "SMA+RSI" : "双均线"} />
        <MetricCard label="本地样本数" value={String(range?.count ?? 0)} />
        <MetricCard label="起始时间" value={fmtTime(range?.minTime)} />
        <MetricCard label="最新时间" value={fmtTime(range?.maxTime)} />
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
          <section style={{ backgroundColor: "var(--color-bg-card)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "16px" }}>
            <div style={{ fontSize: "13px", color: "var(--color-text-primary)", marginBottom: "12px", fontWeight: 600 }}>训练段表现</div>
            <MetricsGrid metrics={result.split.train.metrics} />
          </section>
          <section style={{ backgroundColor: "var(--color-bg-card)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "16px" }}>
            <div style={{ fontSize: "13px", color: "var(--color-text-primary)", marginBottom: "12px", fontWeight: 600 }}>测试段表现</div>
            <MetricsGrid metrics={result.split.test.metrics} />
          </section>
        </>
      )}
    </div>
  );
}
