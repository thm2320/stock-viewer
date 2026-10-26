// src/ws-feeder-service.ts
import { TwelvedataWebSocketClient } from "@twelvedata/twelvedata-node";
import {
  DynamoDBClient,
  BatchWriteItemCommand,
} from "@aws-sdk/client-dynamodb";
import type { WriteRequest } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { toRawTick, toRedisTick } from "./tick-mappers.ts";
import type { RawTick } from "./types.ts";
import type { RedisSink } from "./redis-sink.ts";

const FLUSH_INTERVAL_MS = 1_000;
// DynamoDB BatchWriteItem accepts at most 25 items per call
const MAX_BATCH_SIZE = 25;
// How long to wait for TwelveData to confirm a new subscription
const SUBSCRIBE_TIMEOUT_MS = 5_000;
const SWEEP_INTERVAL_MS = 60_000;

interface StreamFeederConfig {
  symbols: string[];
  redisSink: RedisSink;
  maxSymbols: number;
  idleTtlMs: number;
}

interface SubscriptionEntry {
  pinned: boolean;
  lastRequestedAt: number;
}

export type AddSymbolResult =
  | { ok: true }
  | { ok: false; error: "capacity" | "unsupported" };

export class StreamFeederService {
  private isRunning = false;
  private isFlushing = false;
  private timer: NodeJS.Timeout | null = null;
  private config: StreamFeederConfig;
  private client: TwelvedataWebSocketClient;
  private dynamoDb: DynamoDBClient;
  private redisSink: RedisSink;
  // Latest tick per symbol since the last flush
  private latest = new Map<string, RawTick>();
  // Every symbol currently subscribed (or awaiting confirmation)
  private subscriptions = new Map<string, SubscriptionEntry>();
  // Subscribes awaiting their subscribe-status event, shared by concurrent callers
  private pending = new Map<string, Promise<AddSymbolResult>>();
  private settlers = new Map<string, (success: boolean) => void>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(config: StreamFeederConfig) {
    this.config = config;
    for (const symbol of config.symbols) {
      this.subscriptions.set(symbol, { pinned: true, lastRequestedAt: Date.now() });
    }
    this.redisSink = config.redisSink;
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
    await this.restoreDynamicSymbols();

    this.timer = setInterval(() => {
      this.flush();
    }, FLUSH_INTERVAL_MS);
    this.sweepTimer = setInterval(() => {
      this.sweepIdle();
    }, SWEEP_INTERVAL_MS);
  }

  public getSubscriptions(): { pinned: string[]; dynamic: string[] } {
    const pinned: string[] = [];
    const dynamic: string[] = [];
    for (const [symbol, entry] of this.subscriptions) {
      (entry.pinned ? pinned : dynamic).push(symbol);
    }
    return { pinned, dynamic };
  }

  // Idempotent: an existing symbol only has its idle clock refreshed.
  // The SDK replays tracked subscriptions after a reconnect, so nothing extra is needed there.
  public async addSymbol(symbol: string): Promise<AddSymbolResult> {
    const existing = this.subscriptions.get(symbol);
    if (existing) {
      existing.lastRequestedAt = Date.now();
      return this.pending.get(symbol) ?? { ok: true };
    }
    if (this.subscriptions.size >= this.config.maxSymbols) {
      return { ok: false, error: "capacity" };
    }

    this.subscriptions.set(symbol, { pinned: false, lastRequestedAt: Date.now() });
    const result = this.awaitSubscribeStatus(symbol).then(
      async (success): Promise<AddSymbolResult> => {
        this.pending.delete(symbol);
        if (success) {
          await this.redisSink.addDynamicSymbol(symbol);
          return { ok: true };
        }
        this.removeSymbol(symbol);
        return { ok: false, error: "unsupported" };
      },
    );
    this.pending.set(symbol, result);
    this.client.subscribe(symbol);
    return result;
  }

  public removeSymbol(symbol: string): void {
    const entry = this.subscriptions.get(symbol);
    if (!entry || entry.pinned) return;
    this.subscriptions.delete(symbol);
    this.client.unsubscribe(symbol);
    void this.redisSink.removeDynamicSymbol(symbol);
  }

  // Resolves true/false from the matching subscribe-status event, false on timeout
  private awaitSubscribeStatus(symbol: string): Promise<boolean> {
    return new Promise((resolve) => {
      const settle = (success: boolean) => {
        clearTimeout(timeout);
        this.settlers.delete(symbol);
        resolve(success);
      };
      const timeout = setTimeout(() => {
        console.warn(`[StreamFeeder] Subscribe to ${symbol} timed out.`);
        settle(false);
      }, SUBSCRIBE_TIMEOUT_MS);
      this.settlers.set(symbol, settle);
    });
  }

  private sweepIdle(): void {
    const cutoff = Date.now() - this.config.idleTtlMs;
    for (const [symbol, entry] of this.subscriptions) {
      if (entry.pinned || this.pending.has(symbol)) continue;
      if (entry.lastRequestedAt <= cutoff) {
        console.log(`[StreamFeeder] Unsubscribing idle symbol ${symbol}.`);
        this.removeSymbol(symbol);
      }
    }
  }

  private async restoreDynamicSymbols(): Promise<void> {
    const stored = await this.redisSink.loadDynamicSymbols();
    const restored = stored
      .filter((symbol) => !this.subscriptions.has(symbol))
      .slice(0, Math.max(0, this.config.maxSymbols - this.subscriptions.size));
    for (const symbol of restored) {
      this.subscriptions.set(symbol, { pinned: false, lastRequestedAt: Date.now() });
    }
    if (restored.length > 0) {
      this.client.subscribe(restored);
      console.log(`[StreamFeeder] Restored dynamic symbols: ${restored.join(", ")}`);
    }
  }

  public async stop(): Promise<void> {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.client.disconnect();
    await this.flush();
    await this.redisSink.close();
    console.log("[StreamFeeder] Service stopped gracefully.");
  }

  private registerListeners(): void {
    this.client.on("price", (event) => {
      try {
        const tick = toRawTick(event, Date.now());
        // Redis gets every tick as it arrives; only DynamoDB is batched by flush.
        // publish never throws, so it cannot affect the DynamoDB write.
        void this.redisSink.publish([toRedisTick(tick)]);
        this.latest.set(event.symbol, tick);
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
      for (const item of event.success) this.settlers.get(item.symbol)?.(true);
      for (const item of event.fails) {
        this.settlers.get(item.symbol)?.(false);
        // A restored symbol that no longer subscribes should not be retried on every boot
        if (!this.pending.has(item.symbol)) this.removeSymbol(item.symbol);
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
