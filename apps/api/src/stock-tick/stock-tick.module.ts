import { Module } from '@nestjs/common';
import { StockTickGateway } from './stock-tick.gateway.js';
import { RedisSubscriberModule } from '../redis/redis-subscriber.module.js';

@Module({
  imports: [RedisSubscriberModule],
  providers: [StockTickGateway],
})
export class StockTickModule {}
