import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getCandles, getDataRange } from "../db";
import { evaluateLatestSignal, type BacktestParams } from "../backtest/engine";
import type { Interval } from "../types";

interface LockedStrategyConfig extends Partial<BacktestParams> {
  name: string;
  description?: string;
  exchange: string;
  symbol: string;
  interval: Interval;
  breadthSymbols?: string[];
  validatedAt?: string;
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const lockedConfigPath = resolve(projectRoot, "configs/locked-strategy-v1.json");

function loadLockedConfig(): LockedStrategyConfig {
  return JSON.parse(readFileSync(lockedConfigPath, "utf-8")) as LockedStrategyConfig;
}

export async function registerRealtimeSignalRoutes(app: FastifyInstance) {
  app.get("/api/realtime-signal", async (_request, reply) => {
    const config = loadLockedConfig();
    const limit = 50000;
    const candles = getCandles({ exchange: config.exchange, symbol: config.symbol, interval: config.interval, limit });

    if (candles.length < 200) {
      return reply.code(400).send({
        ok: false,
        message: `历史K线不足，当前${candles.length}根，建议先补充 ${config.exchange} / ${config.symbol} / ${config.interval} 数据`,
      });
    }

    const breadthSymbols = [...new Set(config.breadthSymbols ?? [])].filter(Boolean);
    const breadthCandlesBySymbol = config.useMarketBreadthFilter
      ? Object.fromEntries(
        breadthSymbols.map((symbol) => [
          symbol,
          getCandles({ exchange: config.exchange, symbol, interval: config.interval, limit }),
        ])
      )
      : undefined;

    const evaluation = evaluateLatestSignal(candles, config, breadthCandlesBySymbol);
    const range = getDataRange(config.symbol, config.interval, config.exchange);

    return {
      ok: true,
      config: {
        name: config.name,
        description: config.description,
        validatedAt: config.validatedAt,
        exchange: config.exchange,
        symbol: config.symbol,
        interval: config.interval,
        strategy: config.strategy,
        fastPeriod: config.fastPeriod,
        slowPeriod: config.slowPeriod,
        tradeDirection: config.tradeDirection,
        useHigherTimeframeFilter: config.useHigherTimeframeFilter,
        higherTimeframe: config.higherTimeframe,
        higherTimeframeSmaPeriod: config.higherTimeframeSmaPeriod,
        requireHigherTimeframeSlope: config.requireHigherTimeframeSlope,
        useMarketBreadthFilter: config.useMarketBreadthFilter,
        breadthSymbols,
        breadthTimeframe: config.breadthTimeframe,
        breadthSmaPeriod: config.breadthSmaPeriod,
        breadthBullThreshold: config.breadthBullThreshold,
        breadthBearThreshold: config.breadthBearThreshold,
        breadthNeutralMode: config.breadthNeutralMode,
      },
      range,
      candleCount: candles.length,
      evaluation,
    };
  });
}
