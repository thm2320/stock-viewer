import { Module } from '@nestjs/common';
import { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../config.js';
import {
  REDIS_FACTORY,
  type RedisFactory,
  type RedisRole,
} from './redis.tokens.js';
import { TickSubscriberService } from './tick-subscriber.service.js';

const COMMAND_TIMEOUT_MS = 2_000;
const MAX_RETRY_DELAY_MS = 5_000;

export function createRedisFactory(redisUrl: string): RedisFactory {
  return (role: RedisRole) => {
    return new Redis(redisUrl, {
      connectionName: `api-${role}`,
      // Connected explicitly at boot so a bad URL fails fast
      lazyConnect: true,
      // Retry forever with capped backoff, like ingest
      retryStrategy: (times) => Math.min(times * 200, MAX_RETRY_DELAY_MS),
      // A subscriber must queue its PSUBSCRIBE until connected; commands must
      // fail fast so a Redis outage never stalls a snapshot read
      ...(role === 'command' && {
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        commandTimeout: COMMAND_TIMEOUT_MS,
      }),
    });
  };
}

@Module({
  providers: [
    {
      provide: REDIS_FACTORY,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createRedisFactory(config.redisUrl),
    },
    TickSubscriberService,
  ],
  exports: [TickSubscriberService],
})
export class RedisModule {}
