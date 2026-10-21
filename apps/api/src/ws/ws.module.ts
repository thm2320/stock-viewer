import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module.js';
import { TicksGateway } from './ticks.gateway.js';

@Module({
  imports: [RedisModule],
  providers: [TicksGateway],
})
export class WsModule {}
