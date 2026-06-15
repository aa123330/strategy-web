import { useEffect, useRef, useState, useCallback } from "react";
import { getContract, type CandleRow } from "../services/gatePublicApi";
import { GateWsClient, type GateInterval } from "../services/gateWs";
import { BinanceWsClient, type BinanceInterval } from "../services/binanceWs";
import { OkxWsClient, type OkxInterval } from "../services/okxWs";
import { useMarketStore, type DataSourceName, type ConnectionStatus } from "../store";

type WsClientType = GateWsClient | BinanceWsClient | OkxWsClient;
type RealtimeSource = "gate" | "binance" | "okx";

const SOURCE_ORDER: DataSourceName[] = ["gate", "binance", "okx", "fallback"];
const INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;

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
    `https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=ETH_USDT&interval=${interval}&limit=300&_t=${Date.now()}`,
    { headers: { Accept: "application/json" } }
  );
  if (!resp.ok) throw new Error("Gate HTTP " + resp.status);
  const data = await resp.json();
  if (!Array.isArray(data)) throw new Error("Gate K线格式异常");
  return data.map(normalizeGateCandle);
}

export function useMarketData() {
  const {
    interval,
    preferredSource,
    activeSource,
    connectionStatus,
    dataSource,
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
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setConnectionStatus("error");
        setConnectionError("备用HTTP行情也无法获取数据");
      }
    };

    if (safeSource === "fallback") {
      loadHttpFallback();
      return () => {
        cancelled = true;
      };
    }

    const onUpdate = (candles: CandleRow[]) => {
      if (cancelled) return;
      if (!candles.length) return;
      lastDataTime.current = Date.now();
      setCandles(candles, safeSource);
      setConnectionError(null);
    };

    const onStatus = (status: ConnectionStatus) => {
      if (cancelled) return;
      setConnectionStatus(status);
      if ((status === "error" || status === "disconnected") && Date.now() - lastDataTime.current > 5000) {
        setTimeout(() => switchToNextSource(`${safeSource} 实时连接异常`), 1000);
      }
    };

    try {
      const realtimeSource = safeSource as RealtimeSource;
      if (realtimeSource === "binance") {
        wsRef.current = new BinanceWsClient(normalizedInterval as BinanceInterval, onUpdate, onStatus);
      } else if (realtimeSource === "okx") {
        wsRef.current = new OkxWsClient(normalizedInterval as OkxInterval, onUpdate, onStatus);
      } else {
        wsRef.current = new GateWsClient(normalizedInterval as GateInterval, onUpdate, onStatus);
      }
      wsRef.current.connect();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      switchToNextSource(`${safeSource} 初始化失败`);
    }

    return () => {
      cancelled = true;
      if (wsRef.current) {
        wsRef.current.disconnect();
        wsRef.current = null;
      }
    };
  }, [interval, preferredSource, selectedSource, setActiveSource, setCandles, setConnectionError, setConnectionStatus, setError, setLoading, switchToNextSource]);

  useEffect(() => {
    if (staleTimerRef.current) clearInterval(staleTimerRef.current);
    staleTimerRef.current = setInterval(() => {
      if (preferredSource !== "auto") return;
      if (!lastDataTime.current) return;
      if (Date.now() - lastDataTime.current > 60000) {
        switchToNextSource(`${selectedSource} 超过60秒无新数据`);
        lastDataTime.current = Date.now();
      }
    }, 10000);
    return () => {
      if (staleTimerRef.current) clearInterval(staleTimerRef.current);
      staleTimerRef.current = null;
    };
  }, [preferredSource, selectedSource, switchToNextSource]);

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
