import type { CandleRow } from "./gatePublicApi";

export type BinanceInterval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

type WsStatus = "connecting" | "connected" | "error" | "disconnected";

interface BinanceKlineData {
  t: number;
  i: string;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
}

interface BinanceKlineMessage {
  k: BinanceKlineData;
}

export class BinanceWsClient {
  private ws: WebSocket | null = null;
  private interval: BinanceInterval;
  private onUpdate: (candles: CandleRow[]) => void;
  private onStatusChange: (status: WsStatus) => void;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private candles: CandleRow[] = [];

  constructor(
    interval: BinanceInterval,
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
      this.ws = new WebSocket(`wss://fstream.binance.com/ws/ethusdt@kline_${this.interval}`);

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.onStatusChange("connected");
      };

      this.ws.onmessage = (event) => {
        try {
          const msg: BinanceKlineMessage = JSON.parse(event.data);
          if (msg.k && msg.k.i === this.interval) {
            this.updateCandles({
              time: Math.floor(msg.k.t / 1000),
              open: Number(msg.k.o),
              high: Number(msg.k.h),
              low: Number(msg.k.l),
              close: Number(msg.k.c),
              volume: Number(msg.k.v),
              is_ascending: Number(msg.k.c) >= Number(msg.k.o),
              turnover: "0",
            });
          }
        } catch {
          return;
        }
      };

      this.ws.onerror = () => this.onStatusChange("error");
      this.ws.onclose = () => {
        this.onStatusChange("disconnected");
        this.scheduleReconnect();
      };
    } catch {
      this.onStatusChange("error");
      this.scheduleReconnect();
    }
  }

  private async fetchHistorical() {
    const resp = await fetch(
      `https://fapi.binance.com/fapi/v1/klines?symbol=ETHUSDT&interval=${this.interval}&limit=300`
    );
    if (!resp.ok) throw new Error("Binance HTTP " + resp.status);
    const data = await resp.json();
    this.candles = data.map((item: string[]) => ({
      time: Math.floor(Number(item[0]) / 1000),
      open: Number(item[1]),
      high: Number(item[2]),
      low: Number(item[3]),
      close: Number(item[4]),
      volume: Number(item[5]),
      is_ascending: Number(item[4]) >= Number(item[1]),
      turnover: "0",
    }));
    this.onUpdate([...this.candles]);
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
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close();
      this.ws = null;
    }
  }
}
