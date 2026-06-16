import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Candle, CandleInput, Interval } from "./types";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dbPath = resolve(projectRoot, "server/data/market.sqlite");
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

export function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS candles (
      exchange TEXT NOT NULL,
      symbol TEXT NOT NULL,
      interval TEXT NOT NULL,
      time INTEGER NOT NULL,
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
      volume REAL NOT NULL,
      turnover REAL,
      PRIMARY KEY (exchange, symbol, interval, time)
    );

    CREATE INDEX IF NOT EXISTS idx_candles_lookup
    ON candles (exchange, symbol, interval, time DESC);
  `);
}

initDb();

const upsertStmt = db.prepare(`
  INSERT INTO candles (exchange, symbol, interval, time, open, high, low, close, volume, turnover)
  VALUES (@exchange, @symbol, @interval, @time, @open, @high, @low, @close, @volume, @turnover)
  ON CONFLICT(exchange, symbol, interval, time) DO UPDATE SET
    open = excluded.open,
    high = excluded.high,
    low = excluded.low,
    close = excluded.close,
    volume = excluded.volume,
    turnover = excluded.turnover
`);

const insertMany = db.transaction((candles: CandleInput[]) => {
  for (const candle of candles) upsertStmt.run({ ...candle, turnover: candle.turnover ?? null });
});

export function upsertCandles(candles: CandleInput[]) {
  if (!candles.length) return 0;
  insertMany(candles);
  return candles.length;
}

export function getCandles(params: {
  exchange?: string;
  symbol: string;
  interval: Interval;
  limit?: number;
  from?: number;
  to?: number;
}): Candle[] {
  const exchange = params.exchange ?? "gate";
  const limit = Math.min(Math.max(params.limit ?? 1000, 1), 50000);
  const conditions = ["exchange = @exchange", "symbol = @symbol", "interval = @interval"];
  const queryParams: Record<string, string | number> = { exchange, symbol: params.symbol, interval: params.interval, limit };

  if (params.from) {
    conditions.push("time >= @from");
    queryParams.from = params.from;
  }
  if (params.to) {
    conditions.push("time <= @to");
    queryParams.to = params.to;
  }

  const rows = db.prepare(`
    SELECT exchange, symbol, interval, time, open, high, low, close, volume, turnover
    FROM candles
    WHERE ${conditions.join(" AND ")}
    ORDER BY time DESC
    LIMIT @limit
  `).all(queryParams) as Candle[];

  return rows.reverse();
}

export function getDataRange(symbol: string, interval: Interval, exchange = "gate") {
  return db.prepare(`
    SELECT MIN(time) AS minTime, MAX(time) AS maxTime, COUNT(*) AS count
    FROM candles
    WHERE exchange = ? AND symbol = ? AND interval = ?
  `).get(exchange, symbol, interval) as { minTime: number | null; maxTime: number | null; count: number };
}
