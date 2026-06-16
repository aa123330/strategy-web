import type { CandleRow } from "./gatePublicApi";

export type GateInterval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

type WsStatus = "connecting" | "connected" | "error" | "disconnected";

interface GateCandlePayload {
  t: number | string;
  o: number | string;
  h: number | string;
  l: number | string;
  c: number | string;
  v: number | string;
  n?: string;
  a?: number | string;
  w?: boolean;
  sum?: number | string;
}

interface GateTickerPayload {
  contract: string;
  last?: string;
  mark_price?: string;
  index_price?: string;
  volume_24h_quote?: string;
}

interface GateTradePayload {
  contract: string;
  price: string;
  size: number | string;
  create_time?: number;
  create_time_ms?: number;
}

interface GateWsMessage {
  time?: number;
  channel?: string;
  event?: string;
  error?: { message?: string };
  result?: GateCandlePayload[] | GateTickerPayload[] | GateTradePayload[] | { status?: string } | null;
}

function intervalToSeconds(interval: GateInterval): number {
  const map: Record<GateInterval, number> = {
    "1m": 60,
    "5m": 300,
    "15m": 900,
    "1h": 3600,
    "4h": 14400,
    "1d": 86400,
  };
  return map[interval];
}

export class GateWsClient {
  private ws: WebSocket | null = null;
  private interval: GateInterval;
  private onUpdate: (candles: CandleRow[]) => void;
  private onStatusChange: (status: WsStatus) => void;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private candles: CandleRow[] = [];
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private manuallyClosed = false;

  constructor(
    interval: GateInterval,
    onUpdate: (candles: CandleRow[]) => void,
    onStatusChange: (status: WsStatus) => void
  ) {
    this.interval = interval;
    this.onUpdate = onUpdate;
    this.onStatusChange = onStatusChange;
  }

  async connect() {
    this.manuallyClosed = false;
    this.onStatusChange("connecting");
    try {
      await this.fetchHistorical();
      if (this.manuallyClosed) return;
      this.ws = new WebSocket("wss://fx-ws.gateio.ws/v4/ws/usdt");

      this.ws.onopen = () => {
        if (this.manuallyClosed) return;
        this.reconnectAttempts = 0;
        this.onStatusChange("connected");
        const time = Math.floor(Date.now() / 1000);
        this.ws?.send(
          JSON.stringify({
            time,
            channel: "futures.candlesticks",
            event: "subscribe",
            payload: [this.interval, "ETH_USDT"],
          })
        );
        this.ws?.send(
          JSON.stringify({
            time,
            channel: "futures.tickers",
            event: "subscribe",
            payload: ["ETH_USDT"],
          })
        );
        this.ws?.send(
          JSON.stringify({
            time,
            channel: "futures.trades",
            event: "subscribe",
            payload: ["ETH_USDT"],
          })
        );
      };

      this.ws.onmessage = (event) => {
        if (this.manuallyClosed) return;
        try {
          const msg: GateWsMessage = JSON.parse(event.data);
          if (msg.error) {
            this.onStatusChange("error");
            return;
          }
          if (msg.channel === "futures.pong") return;
          if (msg.event === "subscribe") {
            const result = msg.result as { status?: string } | null;
            if (result?.status === "success") this.onStatusChange("connected");
            return;
          }
          if (msg.event !== "update" || !msg.result || !Array.isArray(msg.result)) return;
          if (msg.channel === "futures.candlesticks") {
            (msg.result as GateCandlePayload[]).forEach((item) => this.updateCandles(this.normalizeCandle(item)));
            return;
          }
          if (msg.channel === "futures.tickers") {
            (msg.result as GateTickerPayload[]).forEach((item) => this.updateFromTicker(item));
            return;
          }
          if (msg.channel === "futures.trades") {
            (msg.result as GateTradePayload[]).forEach((item) => this.updateFromTrade(item));
          }
        } catch {
          return;
        }
      };

      this.ws.onerror = () => {
        if (!this.manuallyClosed) this.onStatusChange("error");
      };
      this.ws.onclose = () => {
        if (this.manuallyClosed) return;
        this.onStatusChange("disconnected");
        this.scheduleReconnect();
      };

      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(
            JSON.stringify({
              time: Math.floor(Date.now() / 1000),
              channel: "futures.ping",
            })
          );
        }
      }, 20000);
    } catch {
      if (this.manuallyClosed) return;
      this.onStatusChange("error");
      this.scheduleReconnect();
    }
  }

  private async fetchHistorical() {
    const resp = await fetch(
      `/gate-api/api/v4/futures/usdt/candlesticks?contract=ETH_USDT&interval=${this.interval}&limit=300`
    );
    if (!resp.ok) throw new Error("Gate HTTP " + resp.status);
    const data = await resp.json();
    if (!Array.isArray(data)) throw new Error("Gate data invalid");
    this.candles = data.map((item: GateCandlePayload) => this.normalizeCandle(item));
    this.onUpdate([...this.candles]);
  }

  private normalizeCandle(item: GateCandlePayload): CandleRow {
    return {
      time: Number(item.t),
      open: Number(item.o),
      high: Number(item.h),
      low: Number(item.l),
      close: Number(item.c),
      volume: Number(item.v),
      is_ascending: Number(item.c) >= Number(item.o),
      turnover: String(item.a ?? item.sum ?? "0"),
    };
  }

  private updateCandles(candle: CandleRow) {
    if (!this.candles.length) {
      this.candles = [candle];
      this.onUpdate([...this.candles]);
      return;
    }
    const last = this.candles[this.candles.length - 1];
    if (candle.time === last.time) {
      this.candles[this.candles.length - 1] = candle;
    } else if (candle.time > last.time) {
      this.candles.push(candle);
      if (this.candles.length > 300) this.candles.shift();
    }
    this.onUpdate([...this.candles]);
  }

  private updateFromTicker(ticker: GateTickerPayload) {
    if (ticker.contract !== "ETH_USDT") return;
    const price = Number(ticker.last || ticker.mark_price || ticker.index_price);
    if (!Number.isFinite(price) || price <= 0) return;
    this.applyRealtimePrice(price, Math.floor(Date.now() / 1000), ticker.volume_24h_quote);
  }

  private updateFromTrade(trade: GateTradePayload) {
    if (trade.contract !== "ETH_USDT") return;
    const price = Number(trade.price);
    if (!Number.isFinite(price) || price <= 0) return;
    const ts = trade.create_time_ms ? Math.floor(Number(trade.create_time_ms) / 1000) : Number(trade.create_time || Math.floor(Date.now() / 1000));
    this.applyRealtimePrice(price, ts);
  }

  private applyRealtimePrice(price: number, timestamp: number, turnover?: string) {
    if (!this.candles.length) return;
    const step = intervalToSeconds(this.interval);
    const candleTime = Math.floor(timestamp / step) * step;
    const last = { ...this.candles[this.candles.length - 1] };

    if (candleTime > last.time) {
      this.candles.push({
        time: candleTime,
        open: last.close,
        high: Math.max(last.close, price),
        low: Math.min(last.close, price),
        close: price,
        volume: 0,
        is_ascending: price >= last.close,
        turnover: turnover ?? "0",
      });
      if (this.candles.length > 300) this.candles.shift();
    } else {
      last.close = price;
      last.high = Math.max(last.high, price);
      last.low = Math.min(last.low, price);
      last.is_ascending = last.close >= last.open;
      if (turnover) last.turnover = turnover;
      this.candles[this.candles.length - 1] = last;
    }

    this.onUpdate([...this.candles]);
  }

  private scheduleReconnect() {
    if (this.manuallyClosed) return;
    if (this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    if (this.reconnectAttempts > this.maxReconnectAttempts) return;
    const delay = Math.min(this.reconnectAttempts * 2000, 10000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  disconnect() {
    this.manuallyClosed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close();
      this.ws = null;
    }
  }
}
