import { Module } from "@nestjs/common";
import { RedisSubscriberService } from "./redis-subscriber.service.js";

@Module({
  providers: [
    RedisSubscriberService,
  ],
  exports: [RedisSubscriberService],
})
export class RedisSubscriberModule {}