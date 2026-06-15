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
  a?: boolean;
  sum?: string;
}

interface GateWsMessage {
  time?: number;
  channel?: string;
  event?: string;
  result?: GateCandlePayload[] | GateCandlePayload;
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
    this.onStatusChange("connecting");
    try {
      await this.fetchHistorical();
      this.ws = new WebSocket("wss://fx-ws.gateio.ws/v4/ws/usdt");

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.onStatusChange("connected");
        this.ws?.send(
          JSON.stringify({
            time: Math.floor(Date.now() / 1000),
            channel: "futures.candlesticks",
            event: "subscribe",
            payload: [this.interval, "ETH_USDT"],
          })
        );
      };

      this.ws.onmessage = (event) => {
        try {
          const msg: GateWsMessage = JSON.parse(event.data);
          if (msg.channel !== "futures.candlesticks" || msg.event !== "update" || !msg.result) return;
          const rows = Array.isArray(msg.result) ? msg.result : [msg.result];
          rows.forEach((item) => this.updateCandles(this.normalizeCandle(item)));
        } catch {
          return;
        }
      };

      this.ws.onerror = () => this.onStatusChange("error");
      this.ws.onclose = () => {
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
      this.onStatusChange("error");
      this.scheduleReconnect();
    }
  }

  private async fetchHistorical() {
    const resp = await fetch(
      `https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=ETH_USDT&interval=${this.interval}&limit=300`
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
      is_ascending: Boolean(item.a),
      turnover: item.sum ?? "0",
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

  private scheduleReconnect() {
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
