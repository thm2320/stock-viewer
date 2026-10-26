// src/index.ts
import { StockFeederService } from "./feeder-service.ts";
import { StreamFeederService } from "./ws-feeder-service.ts";
import { ControlServer } from "./control-server.ts";
import { RedisSink } from "./redis-sink.ts";

// Free-tier TwelveData limit: 8 API requests per minute
const FREE_TIER_REQUESTS_PER_MINUTE = 8;
// Free-tier TwelveData limit: 8 concurrent WebSocket symbols
const DEFAULT_MAX_SYMBOLS = 8;
const DEFAULT_CONTROL_PORT = 3003;
const DEFAULT_IDLE_TTL_MS = 600_000;
const DEFAULT_POLL_INTERVAL_MS = 60_000;

// ws streams ticks into the ticks table; rest polls quotes into the quotes table
const feedMode = process.env.FEED_MODE ?? "ws";
if (feedMode !== "ws" && feedMode !== "rest") {
  console.error(`Invalid FEED_MODE "${feedMode}": expected "ws" or "rest".`);
  process.exit(1);
}

const requiredEnv = [
  "TWELVEDATA_API_KEY",
  feedMode === "ws" ? "TICKS_TABLE_NAME" : "DYNAMODB_TABLE_NAME",
  "AWS_REGION",
  "REDIS_URL",
  ...(feedMode === "ws" ? ["INGEST_TOKEN"] : []),
];
const missingEnv = requiredEnv.filter((name) => !process.env[name]);
if (missingEnv.length > 0) {
  console.error(
    `Missing required environment variables: ${missingEnv.join(", ")}`,
  );
  process.exit(1);
}

try {
  const { protocol } = new URL(process.env.REDIS_URL!);
  if (protocol !== "redis:" && protocol !== "rediss:")
    throw new Error(protocol);
} catch {
  console.error(`Invalid REDIS_URL: expected a redis:// or rediss:// URL.`);
  process.exit(1);
}

const symbols = (process.env.SYMBOLS ?? "AAPL")
  .split(",")
  .map((symbol) => symbol.trim())
  .filter(Boolean);
const pollIntervalMs =
  Number(process.env.POLL_INTERVAL_MS) || DEFAULT_POLL_INTERVAL_MS;

const maxSymbols = Number(process.env.MAX_SYMBOLS) || DEFAULT_MAX_SYMBOLS;
const controlPort = Number(process.env.CONTROL_PORT) || DEFAULT_CONTROL_PORT;
const idleTtlMs = Number(process.env.IDLE_TTL_MS) || DEFAULT_IDLE_TTL_MS;

if (feedMode === "ws" && symbols.length > maxSymbols) {
  console.warn(
    `${symbols.length} symbols exceeds MAX_SYMBOLS (${maxSymbols}); some subscriptions may be rejected.`,
  );
} else if (
  feedMode === "rest" &&
  symbols.length > FREE_TIER_REQUESTS_PER_MINUTE
) {
  console.warn(
    `${symbols.length} symbols exceeds the free-tier limit of ${FREE_TIER_REQUESTS_PER_MINUTE} requests per minute; some quotes may be rate limited.`,
  );
}

const redisSink = new RedisSink(process.env.REDIS_URL!);

const streamFeeder =
  feedMode === "ws"
    ? new StreamFeederService({ symbols, redisSink, maxSymbols, idleTtlMs })
    : null;
const feeder =
  streamFeeder ?? new StockFeederService({ symbols, pollIntervalMs, redisSink });
const controlServer = streamFeeder
  ? new ControlServer({
      port: controlPort,
      token: process.env.INGEST_TOKEN!,
      feeder: streamFeeder,
    })
  : null;

console.log(`Starting Stock Market Feeder Ingest Service (${feedMode})...`);
try {
  await feeder.start();
} catch (error) {
  console.error("Failed to start feeder:", error);
  process.exit(1);
}

if (controlServer) {
  try {
    await controlServer.start();
  } catch (error) {
    console.error("Failed to start control server:", error);
    process.exit(1);
  }
} else {
  console.log("Control server disabled in rest mode.");
}

// Handle graceful shutdown on signals
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    console.log(`\nStopping service due to ${signal}...`);
    await controlServer?.stop();
    await feeder.stop();
    process.exit(0);
  });
}
