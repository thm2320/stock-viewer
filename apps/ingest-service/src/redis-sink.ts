// src/redis-sink.ts
import { Redis } from "ioredis";
import { DYNAMIC_SYMBOLS_KEY, quoteKey, tickChannel } from "@repo/shared";
import type { RedisTick } from "@repo/shared";

// Keep a Redis outage from stalling a flush
const COMMAND_TIMEOUT_MS = 2_000;
const MAX_RETRY_DELAY_MS = 5_000;

export class RedisSink {
  private redis: Redis;

  constructor(url: string) {
    this.redis = new Redis(url, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      commandTimeout: COMMAND_TIMEOUT_MS,
      // Retry forever with capped backoff
      retryStrategy: (times) => Math.min(times * 200, MAX_RETRY_DELAY_MS),
    });
    this.redis.on("error", (error) => {
      console.error("[Redis] Error:", error.message);
    });
    this.redis.on("ready", () => {
      console.log("[Redis] Ready.");
    });
    this.redis.on("reconnecting", (delayMs: number) => {
      console.warn(`[Redis] Reconnecting in ${delayMs}ms...`);
    });
  }

  // Never throws; failures are logged so the DynamoDB write still happens
  public async publish(ticks: RedisTick[]): Promise<void> {
    if (ticks.length === 0) return;

    try {
      const pipeline = this.redis.pipeline();
      for (const tick of ticks) {
        const json = JSON.stringify(tick);
        pipeline.set(quoteKey(tick.symbol), json);
        pipeline.publish(tickChannel(tick.symbol), json);
      }

      const results = (await pipeline.exec()) ?? [];
      const failedTicks = new Set<number>();
      results.forEach(([error], i) => {
        if (error) {
          const index = Math.floor(i / 2);
          failedTicks.add(index);
          const tick = ticks[index]!;
          console.error(`[Redis] Command failed for ${tick.symbol}:`, error.message);
        }
      });
      // Per-tick publishing is frequent; only log when something failed
      if (failedTicks.size > 0) {
        console.warn(
          `[Redis] Published ${ticks.length - failedTicks.size}/${ticks.length} ticks.`,
        );
      }
    } catch (error) {
      console.error("[Redis] Publish failed:", error);
    }
  }

  // Never throws; a lost write only means the symbol is not restored on boot
  public async addDynamicSymbol(symbol: string): Promise<void> {
    try {
      await this.redis.sadd(DYNAMIC_SYMBOLS_KEY, symbol);
    } catch (error) {
      console.error(`[Redis] Failed to persist ${symbol}:`, error);
    }
  }

  public async removeDynamicSymbol(symbol: string): Promise<void> {
    try {
      await this.redis.srem(DYNAMIC_SYMBOLS_KEY, symbol);
    } catch (error) {
      console.error(`[Redis] Failed to remove ${symbol}:`, error);
    }
  }

  // Never throws; returns [] when Redis is unavailable
  public async loadDynamicSymbols(): Promise<string[]> {
    try {
      return await this.redis.smembers(DYNAMIC_SYMBOLS_KEY);
    } catch (error) {
      console.error("[Redis] Failed to load dynamic symbols:", error);
      return [];
    }
  }

  public async close(): Promise<void> {
    try {
      await this.redis.quit();
    } catch (error) {
      console.error("[Redis] Quit failed, disconnecting:", error);
      this.redis.disconnect();
    }
  }
}
