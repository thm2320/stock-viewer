// src/ws-feeder-service.ts
import { TwelvedataWebSocketClient } from "@twelvedata/twelvedata-node";
import {
  DynamoDBClient,
  BatchWriteItemCommand,
} from "@aws-sdk/client-dynamodb";
import type { WriteRequest } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { toRawTick } from "./types.ts";
import type { RawTick } from "./types.ts";

const FLUSH_INTERVAL_MS = 1_000;
// DynamoDB BatchWriteItem accepts at most 25 items per call
const MAX_BATCH_SIZE = 25;

interface StreamFeederConfig {
  symbols: string[];
}

export class StreamFeederService {
  private isRunning = false;
  private isFlushing = false;
  private timer: NodeJS.Timeout | null = null;
  private config: StreamFeederConfig;
  private client: TwelvedataWebSocketClient;
  private dynamoDb: DynamoDBClient;
  // Latest tick per symbol since the last flush
  private latest = new Map<string, RawTick>();

  constructor(config: StreamFeederConfig) {
    this.config = config;
    // Without maxAttempts the client gives up after 10 failed reconnects
    this.client = new TwelvedataWebSocketClient({
      apiKey: process.env.TWELVEDATA_API_KEY!,
      reconnect: { maxAttempts: Infinity },
    });
    this.dynamoDb = new DynamoDBClient({
      region: process.env.AWS_REGION,
      endpoint: process.env.AWS_ENDPOINT_URL,
    });
    this.registerListeners();
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    console.log(
      `[StreamFeeder] Service started. Streaming ${this.config.symbols.join(", ")}, flushing every ${FLUSH_INTERVAL_MS / 1000}s...`,
    );

    await this.client.connect();
    this.client.subscribe(this.config.symbols);

    this.timer = setInterval(() => {
      this.flush();
    }, FLUSH_INTERVAL_MS);
  }

  public async stop(): Promise<void> {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.client.disconnect();
    await this.flush();
    console.log("[StreamFeeder] Service stopped gracefully.");
  }

  private registerListeners(): void {
    this.client.on("price", (event) => {
      try {
        this.latest.set(event.symbol, toRawTick(event, Date.now()));
      } catch (error) {
        console.warn("[StreamFeeder] Dropped invalid tick:", error);
      }
    });

    this.client.on("subscribe-status", (event) => {
      if (event.success.length > 0) {
        console.log(
          `[StreamFeeder] Subscribed: ${event.success.map((item) => item.symbol).join(", ")}`,
        );
      }
      if (event.fails.length > 0) {
        console.error(
          `[StreamFeeder] SUBSCRIBE FAILED for ${event.fails.map((item) => item.symbol).join(", ")}:`,
          event.fails,
        );
      }
    });

    this.client.on("reconnecting", ({ attempt, delayMs }) => {
      console.warn(
        `[StreamFeeder] Connection lost, reconnecting (attempt ${attempt}) in ${delayMs}ms...`,
      );
    });
    this.client.on("reconnect", ({ attempt }) => {
      console.log(`[StreamFeeder] Reconnected after ${attempt} attempt(s).`);
    });
    this.client.on("close", (code, reason) => {
      console.warn(`[StreamFeeder] Connection closed (${code}): ${reason}`);
    });
    this.client.on("error", (error) => {
      console.error("[StreamFeeder] WebSocket error:", error);
    });
  }

  // Skip the tick if the previous flush is still running; ticks keep coalescing
  private async flush(): Promise<void> {
    if (this.isFlushing || this.latest.size === 0) return;
    this.isFlushing = true;

    const ticks = [...this.latest.values()];
    this.latest.clear();

    try {
      for (let i = 0; i < ticks.length; i += MAX_BATCH_SIZE) {
        await this.writeBatch(ticks.slice(i, i + MAX_BATCH_SIZE));
      }
    } catch (error) {
      console.error("[Sink] Flush failed:", error);
    } finally {
      this.isFlushing = false;
    }
  }

  private async writeBatch(ticks: RawTick[]): Promise<void> {
    const tableName = process.env.TICKS_TABLE_NAME!;
    let requests: WriteRequest[] = ticks.map((tick) => ({
      PutRequest: {
        Item: marshall(tick, { removeUndefinedValues: true }),
      },
    }));

    // One retry of whatever DynamoDB left unprocessed
    for (let attempt = 0; attempt < 2 && requests.length > 0; attempt++) {
      const response = await this.dynamoDb.send(
        new BatchWriteItemCommand({ RequestItems: { [tableName]: requests } }),
      );
      requests = response.UnprocessedItems?.[tableName] ?? [];
    }

    if (requests.length > 0) {
      console.error(
        `[Sink] Failed to write ${requests.length}/${ticks.length} ticks after retry.`,
      );
    }
    console.log(`[Sink] Wrote ${ticks.length - requests.length}/${ticks.length} ticks.`);
  }
}
