import Fastify from "fastify";
import cors from "@fastify/cors";
import { initDb } from "./db";
import { registerCandleRoutes } from "./routes/candles";
import { registerBacktestRoutes } from "./routes/backtest";

initDb();

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
await registerCandleRoutes(app);
await registerBacktestRoutes(app);

app.get("/api/health", async () => ({ ok: true, time: Date.now() }));

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
