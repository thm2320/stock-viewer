// src/index.ts
import { StockFeederService } from "./feeder-service.ts";

// Free-tier TwelveData limit: 8 API requests per minute
const FREE_TIER_REQUESTS_PER_MINUTE = 8;
const DEFAULT_POLL_INTERVAL_MS = 60_000;

const requiredEnv = ["TWELVEDATA_API_KEY", "DYNAMODB_TABLE_NAME", "AWS_REGION"];
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

if (symbols.length > FREE_TIER_REQUESTS_PER_MINUTE) {
  console.warn(
    `${symbols.length} symbols exceeds the free-tier limit of ${FREE_TIER_REQUESTS_PER_MINUTE} requests per minute; some quotes may be rate limited.`,
  );
}

const feeder = new StockFeederService({
  symbols,
  pollIntervalMs,
});

console.log("Starting Stock Market Feeder Ingest Service...");
feeder.start();

// Handle graceful shutdown on signals
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`\nStopping service due to ${signal}...`);
    feeder.stop();
    process.exit(0);
  });
}
