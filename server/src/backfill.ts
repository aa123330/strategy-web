import { initDb } from "./db";
import { backfillGateCandles } from "./collectors/gateCollector";
import { backfillOkxCandles } from "./collectors/okxCollector";
import type { Interval } from "./types";

initDb();

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i], process.argv[i + 1]);
}

const exchange = args.get("--exchange") ?? "gate";
const symbols = (args.get("--symbols") ?? "BTC_USDT,ETH_USDT").split(",").map((s) => s.trim()).filter(Boolean);
const intervals = (args.get("--intervals") ?? "15m,1h").split(",").map((s) => s.trim()) as Interval[];
const days = Number(args.get("--days") ?? "30");
const onProgress = (message: string) => console.log(message);

const result = exchange === "okx"
  ? await backfillOkxCandles({ symbols, intervals, days, onProgress })
  : await backfillGateCandles({ symbols, intervals, days, onProgress });

console.log(`完成，${exchange} 写入/更新 ${result.inserted} 根K线`);
