import { useEffect, useRef, useMemo } from "react";
import { createChart, ColorType, CandlestickSeries, LineSeries, HistogramSeries } from "lightweight-charts";
import type { IChartApi, ISeriesApi, LineData, HistogramData, Time } from "lightweight-charts";
import { useMarketStore, useStrategyStore, type DataSourceName } from "../store";
import { sma } from "../strategies/indicators";
import { macd } from "../strategies/indicators";
import { RefreshCw, TrendingUp } from "lucide-react";

const INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
const LONG_COLOR = "#00ff88";
const SHORT_COLOR = "#ff3366";
const MA_FAST_COLOR = "#00d4ff";
const MA_SLOW_COLOR = "#ffaa00";
const MACD_DIF_COLOR = "#00d4ff";
const MACD_DEA_COLOR = "#ffaa00";

const beijingTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatBeijingTime(time: Time) {
  if (typeof time !== "number") return String(time);
  return beijingTimeFormatter.format(new Date(time * 1000));
}

function candleToLightweight(candles: { time: number; open: number; high: number; low: number; close: number }[]) {
  return candles.map((c) => ({ time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close }));
}

export default function ChartView() {
  const { candles, interval, setInterval, loading, activeSource, preferredSource, connectionStatus, connectionError, lastUpdatedAt, setPreferredSource } = useMarketStore();
  const { strategy, fastPeriod, slowPeriod, macdFast, macdSlow, macdSignal, signal } = useStrategyStore();

  const sourceLabels: Record<DataSourceName, string> = {
    auto: "自动切换",
    gate: "Gate",
    binance: "Binance",
    okx: "OKX",
    fallback: "HTTP兜底",
  };

  const mainRef = useRef<HTMLDivElement>(null);
  const macdRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const macdChartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const maFastSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const maSlowSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const macdSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const difSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const deaSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);

  // 计算均线数据
  const maFastData = useMemo<LineData[]>(() => {
    if (!candles.length) return [];
    const closes = candles.map((c) => c.close);
    return candles.map((c, i) => {
      const val = sma(closes.slice(0, i + 1), fastPeriod);
      return val !== null ? { time: c.time as Time, value: val } : null;
    }).filter(Boolean) as LineData[];
  }, [candles, fastPeriod]);

  const maSlowData = useMemo<LineData[]>(() => {
    if (!candles.length) return [];
    const closes = candles.map((c) => c.close);
    return candles.map((c, i) => {
      const val = sma(closes.slice(0, i + 1), slowPeriod);
      return val !== null ? { time: c.time as Time, value: val } : null;
    }).filter(Boolean) as LineData[];
  }, [candles, slowPeriod]);

  // 计算 MACD 数据
  const macdData = useMemo(() => {
    if (!candles.length) return { hist: [], dif: [], dea: [] };
    const closes = candles.map((c) => c.close);
    const hist: HistogramData[] = [];
    const dif: LineData[] = [];
    const dea: LineData[] = [];

    for (let i = macdSlow + macdSignal; i <= closes.length; i++) {
      const slice = closes.slice(0, i);
      const result = macd(slice, macdFast, macdSlow, macdSignal);
      if (!result) continue;
      const t = candles[i - 1].time as Time;
      hist.push({ time: t, value: result.hist, color: result.hist >= 0 ? LONG_COLOR : SHORT_COLOR });
      dif.push({ time: t, value: result.dif });
      dea.push({ time: t, value: result.dea });
    }
    return { hist, dif, dea };
  }, [candles, macdFast, macdSlow, macdSignal]);

  // 创建主图图表
  useEffect(() => {
    if (!mainRef.current) return;
    if (chartRef.current) { chartRef.current.remove(); chartRef.current = null; }

    const chart = createChart(mainRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "#0a0a0f" },
        textColor: "#888888",
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 11,
      },
      grid: { vertLines: { color: "#1e1e2e" }, horzLines: { color: "#1e1e2e" } },
      crosshair: { vertLine: { color: "#333344", labelBackgroundColor: "#111118" }, horzLine: { color: "#333344", labelBackgroundColor: "#111118" } },
      rightPriceScale: { borderColor: "#1e1e2e" },
      timeScale: {
        borderColor: "#1e1e2e",
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: formatBeijingTime,
      },
      handleScale: { axisPressedMouseMove: true },
      localization: {
        timeFormatter: formatBeijingTime,
      },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: LONG_COLOR, downColor: SHORT_COLOR, borderUpColor: LONG_COLOR, borderDownColor: SHORT_COLOR, wickUpColor: LONG_COLOR, wickDownColor: SHORT_COLOR,
    });
    const maFastSeries = chart.addSeries(LineSeries, { color: MA_FAST_COLOR, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    const maSlowSeries = chart.addSeries(LineSeries, { color: MA_SLOW_COLOR, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    maFastSeriesRef.current = maFastSeries;
    maSlowSeriesRef.current = maSlowSeries;

    const ro = new ResizeObserver(() => {
      if (mainRef.current && chartRef.current) chartRef.current.applyOptions({ width: mainRef.current.clientWidth });
    });
    ro.observe(mainRef.current);
    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      maFastSeriesRef.current = null;
      maSlowSeriesRef.current = null;
    };
  }, []);

  // 创建 MACD 副图
  useEffect(() => {
    if (!macdRef.current) return;
    if (macdChartRef.current) { macdChartRef.current.remove(); macdChartRef.current = null; }

    const chart = createChart(macdRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "#0a0a0f" },
        textColor: "#888888",
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 11,
      },
      grid: { vertLines: { color: "#1e1e2e" }, horzLines: { color: "#1e1e2e" } },
      crosshair: { mode: 0 },
      rightPriceScale: { borderColor: "#1e1e2e" },
      timeScale: {
        borderColor: "#1e1e2e",
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: formatBeijingTime,
      },
      height: 140,
      localization: {
        timeFormatter: formatBeijingTime,
      },
    });

    const histSeries = chart.addSeries(HistogramSeries, { priceFormat: { type: "price", precision: 4, minMove: 0.0001 }, priceScaleId: "right" });
    const difSeries = chart.addSeries(LineSeries, { color: MACD_DIF_COLOR, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    const deaSeries = chart.addSeries(LineSeries, { color: MACD_DEA_COLOR, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });

    macdChartRef.current = chart;
    macdSeriesRef.current = histSeries;
    difSeriesRef.current = difSeries;
    deaSeriesRef.current = deaSeries;

    const ro = new ResizeObserver(() => {
      if (macdRef.current && macdChartRef.current) macdChartRef.current.applyOptions({ width: macdRef.current.clientWidth });
    });
    ro.observe(macdRef.current);
    return () => {
      ro.disconnect();
      chart.remove();
      macdChartRef.current = null;
      macdSeriesRef.current = null;
      difSeriesRef.current = null;
      deaSeriesRef.current = null;
    };
  }, []);

  // 更新数据
  useEffect(() => {
    if (!candleSeriesRef.current || !candles.length) return;
    candleSeriesRef.current.setData(candleToLightweight(candles));
    maFastSeriesRef.current?.setData(maFastData);
    maSlowSeriesRef.current?.setData(maSlowData);
    chartRef.current?.timeScale().fitContent();

    if (macdSeriesRef.current && macdData.hist.length) {
      macdSeriesRef.current.setData(macdData.hist);
      difSeriesRef.current?.setData(macdData.dif);
      deaSeriesRef.current?.setData(macdData.dea);
      macdChartRef.current?.timeScale().fitContent();
    }
  }, [candles, maFastData, maSlowData, macdData]);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: "0" }}>
      {/* 工具栏 */}
      <div style={{ display: "flex", alignItems: "center", gap: "12px", padding: "12px 16px", borderBottom: "1px solid var(--color-border)", backgroundColor: "var(--color-bg-card)", flexWrap: "wrap" }}>
        {/* 周期切换 */}
        <div style={{ display: "flex", gap: "4px" }}>
          {INTERVALS.map((iv) => (
            <button
              key={iv}
              onClick={() => setInterval(iv)}
              style={{
                padding: "4px 10px",
                borderRadius: "5px",
                border: "none",
                cursor: "pointer",
                fontSize: "12px",
                fontFamily: "var(--font-mono)",
                backgroundColor: interval === iv ? "var(--color-bg-elevated)" : "transparent",
                color: interval === iv ? "var(--color-text-primary)" : "var(--color-text-secondary)",
                fontWeight: interval === iv ? 600 : 400,
                transition: "all 0.15s",
              }}
            >
              {iv}
            </button>
          ))}
        </div>

        {/* 分隔线 */}
        <div style={{ width: "1px", height: "16px", backgroundColor: "var(--color-border)" }} />

        {/* 策略标注 */}
        <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--color-text-secondary)" }}>
          <TrendingUp size={12} />
          <span style={{ fontFamily: "var(--font-mono)" }}>{strategy === "composite" ? "综合评分" : strategy === "dual_ma" ? "双均线" : "MACD"}</span>
          <span style={{ color: MA_FAST_COLOR, fontFamily: "var(--font-mono)" }}>MA{fastPeriod}</span>
          <span style={{ color: MA_SLOW_COLOR, fontFamily: "var(--font-mono)" }}>MA{slowPeriod}</span>
        </div>

        {/* 数据源切换 + 连接状态 */}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "12px", fontSize: "11px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", color: "var(--color-text-secondary)" }}>
            <span>数据源</span>
            <select
              value={preferredSource}
              onChange={(e) => setPreferredSource(e.target.value as DataSourceName)}
              style={{
                backgroundColor: "var(--color-bg-base)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text-primary)",
                borderRadius: "4px",
                padding: "4px 8px",
                fontSize: "11px",
                fontFamily: "var(--font-mono)",
                cursor: "pointer",
              }}
            >
              <option value="auto">自动切换</option>
              <option value="fallback">HTTP兜底</option>
              <option value="gate">Gate</option>
              <option value="binance">Binance</option>
              <option value="okx">OKX</option>
            </select>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "11px", color: "var(--color-text-secondary)", fontFamily: "var(--font-mono)" }}>
            <span style={{
              width: "8px",
              height: "8px",
              borderRadius: "50%",
              backgroundColor: connectionStatus === "connected" ? "var(--color-long)" :
                                connectionStatus === "connecting" ? "#ffaa00" :
                                connectionStatus === "error" ? "var(--color-short)" :
                                "var(--color-text-secondary)",
              display: "inline-block",
            }} />
            <span>{sourceLabels[activeSource]} · {connectionStatus}</span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "6px", color: "var(--color-text-secondary)" }}>
            <RefreshCw size={11} className={loading || activeSource === "fallback" ? "animate-spin" : ""} />
            <span>{candles.length} 根K线</span>
            {lastUpdatedAt && <span>更新 {new Date(lastUpdatedAt).toLocaleTimeString("zh-CN", { hour12: false })}</span>}
          </div>
        </div>

        {connectionError && (
          <div style={{
            width: "100%",
            padding: "6px 16px",
            fontSize: "11px",
            color: "#ff6b6b",
            backgroundColor: "rgba(255,107,107,0.08)",
            borderTop: "1px solid rgba(255,107,107,0.15)",
            fontFamily: "var(--font-mono)",
          }}>
            ⚠ {connectionError}
          </div>
        )}
      </div>

      {/* 图表区域 */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", position: "relative" }}>
        {!candles.length && (
          <div style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "10px",
            color: "var(--color-text-secondary)",
            fontFamily: "var(--font-mono)",
            fontSize: "13px",
            pointerEvents: "none",
            zIndex: 2,
          }}>
            <RefreshCw size={18} className={loading ? "animate-spin" : ""} />
            <div>{loading || connectionStatus === "connecting" ? "正在连接实时行情数据..." : "暂无K线数据"}</div>
            <div style={{ fontSize: "11px" }}>当前数据源：{sourceLabels[activeSource]} · {connectionStatus}</div>
          </div>
        )}

        {/* 主图 */}
        <div ref={mainRef} style={{ flex: 1, minHeight: "280px" }} />

        {/* MACD 副图 */}
        <div style={{ borderTop: "1px solid var(--color-border)" }}>
          <div style={{ padding: "6px 16px", fontSize: "11px", color: "var(--color-text-secondary)", fontFamily: "var(--font-mono)", display: "flex", gap: "12px" }}>
            <span style={{ color: MACD_DIF_COLOR }}>DIF</span>
            <span style={{ color: MACD_DEA_COLOR }}>DEA</span>
            <span style={{ color: LONG_COLOR }}>MACD柱</span>
          </div>
          <div ref={macdRef} style={{ height: "140px" }} />
        </div>
      </div>

      {/* 当前信号指示 */}
      {signal && (
        <div style={{
          padding: "8px 16px",
          borderTop: "1px solid var(--color-border)",
          display: "flex",
          alignItems: "center",
          gap: "10px",
          backgroundColor: "var(--color-bg-card)",
        }}>
          <span style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>当前信号</span>
          <span style={{
            fontFamily: "var(--font-mono)",
            fontSize: "12px",
            fontWeight: 700,
            color: signal.action === "OPEN_LONG" || signal.action === "CLOSE_SHORT" ? LONG_COLOR
              : signal.action === "OPEN_SHORT" || signal.action === "CLOSE_LONG" ? SHORT_COLOR
              : "var(--color-text-secondary)",
          }}>
            {signal.action}
          </span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--color-text-primary)" }}>
            ${signal.price.toFixed(2)}
          </span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--color-text-secondary)" }}>
            评分 {signal.score ?? "--"} · 置信度 {signal.confidence ?? "--"}%
          </span>
          {signal.stopLoss && signal.takeProfit1 && (
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--color-text-secondary)" }}>
              SL ${signal.stopLoss.toFixed(2)} · TP1 ${signal.takeProfit1.toFixed(2)}
            </span>
          )}
          <span style={{ fontSize: "11px", color: "var(--color-text-secondary)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {signal.reason}
          </span>
        </div>
      )}
    </div>
  );
}
