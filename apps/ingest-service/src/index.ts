// src/index.ts
import { StockFeederService } from "./feeder-service.ts";
import { StreamFeederService } from "./ws-feeder-service.ts";

// Free-tier TwelveData limit: 8 API requests per minute
const FREE_TIER_REQUESTS_PER_MINUTE = 8;
// Free-tier TwelveData limit: 8 concurrent WebSocket symbols
const FREE_TIER_WS_SYMBOLS = 8;
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
];
const missingEnv = requiredEnv.filter((name) => !process.env[name]);
if (missingEnv.length > 0) {
  console.error(
    `Missing required environment variables: ${missingEnv.join(", ")}`,
  );
  process.exit(1);
}

const symbols = (process.env.SYMBOLS ?? "AAPL")
  .split(",")
  .map((symbol) => symbol.trim())
  .filter(Boolean);
const pollIntervalMs =
  Number(process.env.POLL_INTERVAL_MS) || DEFAULT_POLL_INTERVAL_MS;

if (feedMode === "ws" && symbols.length > FREE_TIER_WS_SYMBOLS) {
  console.warn(
    `${symbols.length} symbols exceeds the free-tier limit of ${FREE_TIER_WS_SYMBOLS} WebSocket symbols; some subscriptions may be rejected.`,
  );
} else if (feedMode === "rest" && symbols.length > FREE_TIER_REQUESTS_PER_MINUTE) {
  console.warn(
    `${symbols.length} symbols exceeds the free-tier limit of ${FREE_TIER_REQUESTS_PER_MINUTE} requests per minute; some quotes may be rate limited.`,
  );
}

const feeder =
  feedMode === "ws"
    ? new StreamFeederService({ symbols })
    : new StockFeederService({ symbols, pollIntervalMs });

console.log(`Starting Stock Market Feeder Ingest Service (${feedMode})...`);
try {
  await feeder.start();
} catch (error) {
  console.error("Failed to start feeder:", error);
  process.exit(1);
}

// Handle graceful shutdown on signals
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    console.log(`\nStopping service due to ${signal}...`);
    await feeder.stop();
    process.exit(0);
  });
}
