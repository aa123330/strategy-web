import type { CandleRow } from "./gatePublicApi";

export type OkxInterval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

type WsStatus = "connecting" | "connected" | "error" | "disconnected";

function toOkxChannel(interval: OkxInterval): string {
  const map: Record<OkxInterval, string> = {
    "1m": "candle1m",
    "5m": "candle5m",
    "15m": "candle15m",
    "1h": "candle1H",
    "4h": "candle4H",
    "1d": "candle1D",
  };
  return map[interval];
}

export class OkxWsClient {
  private ws: WebSocket | null = null;
  private interval: OkxInterval;
  private onUpdate: (candles: CandleRow[]) => void;
  private onStatusChange: (status: WsStatus) => void;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private candles: CandleRow[] = [];
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private manuallyClosed = false;

  constructor(
    interval: OkxInterval,
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
      this.ws = new WebSocket("wss://ws.okx.com:8443/ws/v5/public");

      this.ws.onopen = () => {
        if (this.manuallyClosed) return;
        this.reconnectAttempts = 0;
        this.onStatusChange("connected");
        const channel = toOkxChannel(this.interval);
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ op: "subscribe", args: [{ channel, instId: "ETH-USDT-SWAP" }] }));
        }
      };

      this.ws.onmessage = (event) => {
        if (this.manuallyClosed) return;
        try {
          if (typeof event.data === "string" && event.data === "pong") return;
          const msg = JSON.parse(event.data);
          if (msg.arg && msg.data) {
            for (const item of msg.data) {
              const open = Number(item[1]);
              const close = Number(item[4]);
              this.updateCandles({
                time: Math.floor(Number(item[0]) / 1000),
                open,
                high: Number(item[2]),
                low: Number(item[3]),
                close,
                volume: Number(item[5]),
                is_ascending: close >= open,
                turnover: "0",
              });
            }
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
          this.ws.send("ping");
        }
      }, 20000);
    } catch {
      if (this.manuallyClosed) return;
      this.onStatusChange("error");
      this.scheduleReconnect();
    }
  }

  private async fetchHistorical() {
    const channel = toOkxChannel(this.interval);
    const resp = await fetch(
      `https://www.okx.com/api/v5/market/candles?instId=ETH-USDT-SWAP&bar=${channel}&limit=300`
    );
    if (!resp.ok) throw new Error("OKX HTTP " + resp.status);
    const json = await resp.json();
    if (json.code !== "0" || !Array.isArray(json.data)) throw new Error("OKX data invalid");
    this.candles = json.data
      .map((item: string[]) => {
        const open = Number(item[1]);
        const close = Number(item[4]);
        return {
          time: Math.floor(Number(item[0]) / 1000),
          open,
          high: Number(item[2]),
          low: Number(item[3]),
          close,
          volume: Number(item[5]),
          is_ascending: close >= open,
          turnover: "0",
        };
      })
      .reverse();
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
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({
            op: "unsubscribe",
            args: [{ channel: toOkxChannel(this.interval), instId: "ETH-USDT-SWAP" }],
          })
        );
      }
      this.ws.close();
      this.ws = null;
    }
  }
}
