import type { FastifyInstance } from "fastify";
import { getCandles, getDataRange } from "../db";
import { createBackfillJob, getBackfillJob } from "../backfillJobs";
import type { Interval } from "../types";

const allowedIntervals = new Set(["1m", "5m", "15m", "1h", "4h", "1d"]);

function parseInterval(value: unknown): Interval {
  const interval = typeof value === "string" && allowedIntervals.has(value) ? value : "15m";
  return interval as Interval;
}

export async function registerCandleRoutes(app: FastifyInstance) {
  app.get("/api/candles", async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const symbol = query.symbol ?? "ETH_USDT";
    const interval = parseInterval(query.interval);
    const exchange = query.exchange ?? "gate";
    const limit = query.limit ? Number(query.limit) : 5000;
    const from = query.from ? Number(query.from) : undefined;
    const to = query.to ? Number(query.to) : undefined;
    const candles = getCandles({ exchange, symbol, interval, limit, from, to });
    const range = getDataRange(symbol, interval, exchange);
    return { exchange, symbol, interval, range, candles };
  });

  app.get("/api/symbols", async () => ({
    symbols: ["BTC_USDT", "ETH_USDT", "SOL_USDT", "BNB_USDT"],
    intervals: ["1m", "5m", "15m", "1h", "4h", "1d"],
  }));

  app.get("/api/backfill/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const job = getBackfillJob(params.id);
    if (!job) return reply.code(404).send({ ok: false, message: "job not found" });
    return reply.send({ ok: true, job });
  });

  app.post("/api/backfill", async (request, reply) => {
    const body = request.body as Partial<{ exchange: "gate" | "okx"; symbols: string[]; intervals: Interval[]; days: number }> | undefined;
    const exchange = body?.exchange ?? "gate";
    const symbols = body?.symbols?.length ? body.symbols : ["BTC_USDT", "ETH_USDT"];
    const intervals = body?.intervals?.length ? body.intervals.map(parseInterval) : ["15m", "1h"];
    const days = Math.min(Math.max(body?.days ?? 30, 1), 730);

    const job = createBackfillJob({ exchange, symbols, intervals, days });
    return reply.send({ ok: true, job });
  });
}
