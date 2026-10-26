import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { quoteKey, type RedisTick } from '@repo/shared';
import { parseRedisTick, truncatePayload } from './parse-tick.js';

/** Regular (non-subscriber) connection for plain commands such as GET. */
@Injectable()
export class RedisClientService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisClientService.name);
  private readonly redis: Redis;

  constructor(configService: ConfigService) {
    this.redis = new Redis(configService.get<string>('REDIS_URL')!);
    this.redis.on('error', (err) =>
      this.logger.error(`Redis error: ${err.message}`),
    );
  }

  /** Latest tick for `symbol` from quote:{symbol}; undefined if absent or unusable. */
  async getQuote(symbol: string): Promise<RedisTick | undefined> {
    const raw = await this.redis.get(quoteKey(symbol));
    if (raw === null) {
      return undefined;
    }
    const tick = parseRedisTick(raw);
    if (!tick) {
      this.logger.warn(
        `Dropping invalid quote for ${symbol}: ${truncatePayload(raw)}`,
      );
      return undefined;
    }
    return { ...tick, symbol };
  }

  async onModuleDestroy() {
    await this.redis.quit();
  }
}
