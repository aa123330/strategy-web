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
        strategy?: "dual_ma" | "sma_rsi_pullback";
        fastPeriod?: number;
        slowPeriod?: number;
        stopLossPct?: number;
        takeProfitPct?: number;
        takeProfitAtrMultiplier?: number;
        rsiPeriod?: number;
        longRsiMax?: number;
        shortRsiMin?: number;
        adxPeriod?: number;
        minAdx?: number;
        atrPeriod?: number;
        atrStopMultiplier?: number;
        atrTrailMultiplier?: number;
        useTrailingStop?: boolean;
        feeRate?: number;
        slippageRate?: number;
        cooldownBars?: number;
        maxHoldBars?: number;
        tradeDirection?: "both" | "long_only" | "short_only";
        useHigherTimeframeFilter?: boolean;
        higherTimeframe?: "4h" | "1d";
        higherTimeframeSmaPeriod?: number;
        requireHigherTimeframeSlope?: boolean;
        signalDelayBars?: number;
        conservativeSameBarExit?: boolean;
        minSlowSmaDistancePct?: number;
        minAtrPct?: number;
        stopLossCircuitLookbackTrades?: number;
        stopLossCircuitMinStops?: number;
        stopLossCircuitCooldownBars?: number;
        useMarketBreadthFilter?: boolean;
        breadthSymbols?: string[];
        breadthTimeframe?: "4h" | "1d";
        breadthSmaPeriod?: number;
        breadthBullThreshold?: number;
        breadthBearThreshold?: number;
        breadthNeutralMode?: "block_all" | "allow_current_filter";
      };
    }> | undefined;

    const exchange = body?.exchange ?? "gate";
    const symbol = body?.symbol ?? "ETH_USDT";
    const interval = parseInterval(body?.interval);
    const limit = body?.limit ?? 50000;
    const candles = getCandles({ exchange, symbol, interval, limit });
    const rawBreadthSymbols = body?.params?.breadthSymbols ?? [];
    const breadthSymbols = [...new Set(rawBreadthSymbols.map((item) => String(item).trim()).filter(Boolean))].filter((item) => item !== symbol);
    const breadthCandlesBySymbol = body?.params?.useMarketBreadthFilter
      ? Object.fromEntries(
        [symbol, ...breadthSymbols].map((breadthSymbol) => [
          breadthSymbol,
          getCandles({ exchange, symbol: breadthSymbol, interval, limit }),
        ])
      )
      : undefined;

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
        breadthCandlesBySymbol,
      }),
    };
  });
}
