import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { ConfigModule } from './config.module.js';
import { RedisModule } from './redis/redis.module.js';
import { WsModule } from './ws/ws.module.js';

@Module({
  imports: [ConfigModule, RedisModule, WsModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
