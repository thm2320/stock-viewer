import { Module } from '@nestjs/common';
import { StockTickGateway } from './stock-tick.gateway.js';
import { RedisSubscriberModule } from '../redis/redis-subscriber.module.js';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module.js';

@Module({
  imports: [RedisSubscriberModule, SubscriptionsModule],
  providers: [StockTickGateway],
})
export class StockTickModule {}
