import { Module } from '@nestjs/common';
import { RedisClientService } from './redis-client.service.js';
import { RedisSubscriberService } from './redis-subscriber.service.js';

@Module({
  providers: [RedisSubscriberService, RedisClientService],
  exports: [RedisSubscriberService, RedisClientService],
})
export class RedisSubscriberModule {}
