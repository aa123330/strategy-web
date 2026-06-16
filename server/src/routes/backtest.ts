import type { FastifyInstance } from "fastify";
import { getCandles } from "../db";
import { runSplitBacktest } from "../backtest/engine";
import type { Interval } from "../types";

const allowedIntervals = new Set(["1m", "5m", "15m", "1h", "4h", "1d"]);

function parseInterval(value: unknown): Interval {
  const interval = typeof value === "string" && allowedIntervals.has(value) ? value : "15m";
  return interval as Interval;
}

export async function registerBacktestRoutes(app: FastifyInstance) {
  app.post("/api/backtest", async (request, reply) => {
    const body = request.body as Partial<{
      exchange: string;
      symbol: string;
      interval: Interval;
      limit: number;
      trainRatio: number;
      params: {
        fastPeriod?: number;
        slowPeriod?: number;
        stopLossPct?: number;
        takeProfitPct?: number;
      };
    }> | undefined;

    const exchange = body?.exchange ?? "gate";
    const symbol = body?.symbol ?? "ETH_USDT";
    const interval = parseInterval(body?.interval);
    const candles = getCandles({ exchange, symbol, interval, limit: body?.limit ?? 50000 });

    if (candles.length < 200) {
      return reply.code(400).send({
        ok: false,
        message: `历史K线不足，当前${candles.length}根，建议先调用 /api/backfill 补数据`,
      });
    }

    return {
      ok: true,
      exchange,
      ...runSplitBacktest({
        symbol,
        interval,
        candles,
        trainRatio: body?.trainRatio,
        strategyParams: body?.params,
      }),
    };
  });
}
