import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { StockTickModule } from './stock-tick/stock-tick.module.js';
import { ConfigModule } from '@nestjs/config';
import { SubscriptionsModule } from './subscriptions/subscriptions.module.js';
import { RedisSubscriberModule } from './redis/redis-subscriber.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    RedisSubscriberModule,
    StockTickModule,
    SubscriptionsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
