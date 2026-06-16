import { useEffect, useRef, useState, useCallback } from "react";
import { getContract, getTicker, type CandleRow } from "../services/gatePublicApi";
import { getLocalCandles, normalizeLocalCandle } from "../services/localDataApi";
import { GateWsClient, type GateInterval } from "../services/gateWs";
import { BinanceWsClient, type BinanceInterval } from "../services/binanceWs";
import { OkxWsClient, type OkxInterval } from "../services/okxWs";
import { useMarketStore, type DataSourceName, type ConnectionStatus } from "../store";

type WsClientType = GateWsClient | BinanceWsClient | OkxWsClient;
type RealtimeSource = "gate" | "binance" | "okx";

const SOURCE_ORDER: DataSourceName[] = ["gate", "binance", "okx", "fallback"];
const INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
const HTTP_REFRESH_MS = 10_000;
const LOCAL_CHART_LIMIT = 1500;
const REALTIME_UPDATE_THROTTLE_MS = 500;

function normalizeInterval(raw: string) {
  return INTERVALS.includes(raw as (typeof INTERVALS)[number]) ? raw : "15m";
}

function normalizeGateCandle(item: { t: string | number; o: string | number; h: string | number; l: string | number; c: string | number; v: string | number; a?: boolean; sum?: string | number }): CandleRow {
  const open = Number(item.o);
  const close = Number(item.c);
  return {
    time: Number(item.t),
    open,
    high: Number(item.h),
    low: Number(item.l),
    close,
    volume: Number(item.v),
    is_ascending: item.a ?? close >= open,
    turnover: String(item.sum ?? "0"),
  };
}

async function fetchGateCandles(interval: string): Promise<CandleRow[]> {
  const resp = await fetch(
    `/gate-api/api/v4/futures/usdt/candlesticks?contract=ETH_USDT&interval=${interval}&limit=300&_t=${Date.now()}`,
    { headers: { Accept: "application/json" } }
  );
  if (!resp.ok) throw new Error("Gate HTTP " + resp.status);
  const data = await resp.json();
  if (!Array.isArray(data)) throw new Error("Gate K线格式异常");
  const candles = data.map(normalizeGateCandle);
  const ticker = await getTicker("ETH_USDT");
  const last = candles.at(-1);
  const livePrice = ticker ? Number(ticker.last || ticker.mark_price) : 0;

  if (last && Number.isFinite(livePrice) && livePrice > 0) {
    last.close = livePrice;
    last.high = Math.max(last.high, livePrice);
    last.low = Math.min(last.low, livePrice);
    last.is_ascending = last.close >= last.open;
  }

  return candles;
}

export function useMarketData() {
  const {
    interval,
    preferredSource,
    activeSource,
    connectionStatus,
    dataSource,
    historicalSource,
    setCandles,
    setContract,
    setLoading,
    setError,
    setActiveSource,
    setConnectionStatus,
    setConnectionError,
  } = useMarketStore();

  const [selectedSource, setSelectedSource] = useState<DataSourceName>("gate");
  const wsRef = useRef<WsClientType | null>(null);
  const lastDataTime = useRef<number>(0);
  const sourceIndexRef = useRef(0);
  const staleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fallbackTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingCandlesRef = useRef<CandleRow[] | null>(null);
  const throttleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFlushTimeRef = useRef(0);

  const switchToNextSource = useCallback((reason: string) => {
    if (preferredSource !== "auto") return;
    sourceIndexRef.current += 1;
    if (sourceIndexRef.current >= SOURCE_ORDER.length) {
      setConnectionError("所有实时数据源连接失败，已停止自动切换");
      setConnectionStatus("error");
      return;
    }
    const next = SOURCE_ORDER[sourceIndexRef.current];
    setConnectionError(`${reason}，切换至 ${next}`);
    setSelectedSource(next);
  }, [preferredSource, setConnectionError, setConnectionStatus]);

  useEffect(() => {
    let cancelled = false;
    const safeSource = preferredSource === "auto" ? selectedSource : preferredSource;
    const normalizedInterval = normalizeInterval(interval);
    sourceIndexRef.current = Math.max(SOURCE_ORDER.indexOf(safeSource), 0);

    if (wsRef.current) {
      wsRef.current.disconnect();
      wsRef.current = null;
    }

    setActiveSource(safeSource, null);
    setLoading(true);
    setConnectionStatus("connecting");
    setConnectionError(null);

    const loadHttpFallback = async () => {
      try {
        const candles = await fetchGateCandles(normalizedInterval);
        if (cancelled) return;
        if (!candles.length) throw new Error("Gate HTTP 返回空K线");
        lastDataTime.current = Date.now();
        setCandles(candles, "fallback");
        setActiveSource("fallback", null);
        setConnectionStatus("connected");
        setConnectionError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setConnectionStatus("error");
        setConnectionError("备用HTTP行情也无法获取数据");
      }
    };

    const startHttpPolling = () => {
      if (fallbackTimerRef.current) clearInterval(fallbackTimerRef.current);
      loadHttpFallback();
      fallbackTimerRef.current = setInterval(loadHttpFallback, HTTP_REFRESH_MS);
    };

    if (safeSource === "fallback") {
      startHttpPolling();
      return () => {
        cancelled = true;
        if (fallbackTimerRef.current) clearInterval(fallbackTimerRef.current);
        fallbackTimerRef.current = null;
      };
    }

    const flushCandles = () => {
      if (cancelled || !pendingCandlesRef.current?.length) return;
      const nextCandles = pendingCandlesRef.current;
      pendingCandlesRef.current = null;
      lastFlushTimeRef.current = Date.now();
      setCandles(nextCandles, safeSource);
      setConnectionError(null);
    };

    const onUpdate = (candles: CandleRow[]) => {
      if (cancelled) return;
      if (!candles.length) return;
      lastDataTime.current = Date.now();
      pendingCandlesRef.current = candles;
      const elapsed = Date.now() - lastFlushTimeRef.current;
      if (elapsed >= REALTIME_UPDATE_THROTTLE_MS) {
        if (throttleTimerRef.current) {
          clearTimeout(throttleTimerRef.current);
          throttleTimerRef.current = null;
        }
        flushCandles();
        return;
      }
      if (!throttleTimerRef.current) {
        throttleTimerRef.current = setTimeout(() => {
          throttleTimerRef.current = null;
          flushCandles();
        }, REALTIME_UPDATE_THROTTLE_MS - elapsed);
      }
    };

    const loadLocalCandles = async () => {
      const local = await getLocalCandles({ exchange: historicalSource, symbol: "ETH_USDT", interval: normalizedInterval, limit: LOCAL_CHART_LIMIT });
      if (cancelled || !local?.candles.length) return [];
      const candles = local.candles.map(normalizeLocalCandle);
      lastDataTime.current = Date.now();
      setCandles(candles, "local-db");
      setConnectionError(`已加载 ${historicalSource.toUpperCase()} 本地长期K线 ${local.range.count} 根，实时数据继续由 ${safeSource} 推送`);
      return candles;
    };

    const onStatus = (status: ConnectionStatus) => {
      if (cancelled) return;
      setConnectionStatus(status);
      if ((status === "error" || status === "disconnected") && Date.now() - lastDataTime.current > 5000) {
        if (preferredSource === "auto") {
          setTimeout(() => switchToNextSource(`${safeSource} 实时连接异常`), 1000);
        } else {
          setConnectionError(`${safeSource} 实时连接异常，已启用 HTTP 轮询刷新`);
          startHttpPolling();
        }
      }
    };

    const connectRealtime = async () => {
      try {
        const initialCandles = await loadLocalCandles();
        if (cancelled) return;
        const realtimeSource = safeSource as RealtimeSource;
        if (realtimeSource === "binance") {
          wsRef.current = new BinanceWsClient(normalizedInterval as BinanceInterval, onUpdate, onStatus);
        } else if (realtimeSource === "okx") {
          wsRef.current = new OkxWsClient(normalizedInterval as OkxInterval, onUpdate, onStatus);
        } else {
          wsRef.current = new GateWsClient(normalizedInterval as GateInterval, onUpdate, onStatus, initialCandles);
        }
        wsRef.current.connect();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        switchToNextSource(`${safeSource} 初始化失败`);
      }
    };

    connectRealtime();

    return () => {
      cancelled = true;
      if (wsRef.current) {
        wsRef.current.disconnect();
        wsRef.current = null;
      }
      if (fallbackTimerRef.current) clearInterval(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
      if (throttleTimerRef.current) clearTimeout(throttleTimerRef.current);
      throttleTimerRef.current = null;
      pendingCandlesRef.current = null;
    };
  }, [historicalSource, interval, preferredSource, selectedSource, setActiveSource, setCandles, setConnectionError, setConnectionStatus, setError, setLoading, switchToNextSource]);

  useEffect(() => {
    if (staleTimerRef.current) clearInterval(staleTimerRef.current);
    staleTimerRef.current = setInterval(() => {
      if (preferredSource !== "auto") return;
      if (!lastDataTime.current) return;
      if (Date.now() - lastDataTime.current > 15_000) {
        if (sourceIndexRef.current >= SOURCE_ORDER.length - 2) {
          setConnectionError(`${selectedSource} 超过15秒无新数据，已启用 HTTP 轮询刷新`);
          setSelectedSource("fallback");
        } else {
          switchToNextSource(`${selectedSource} 超过60秒无新数据`);
        }
        lastDataTime.current = Date.now();
      }
    }, 10000);
    return () => {
      if (staleTimerRef.current) clearInterval(staleTimerRef.current);
      staleTimerRef.current = null;
    };
  }, [preferredSource, selectedSource, setConnectionError, switchToNextSource]);

  useEffect(() => {
    getContract("ETH_USDT").then((contract) => {
      if (contract) setContract(contract);
    });
  }, [setContract]);

  return {
    activeSource,
    connectionStatus,
    dataSource,
    preferredSource,
  };
}
