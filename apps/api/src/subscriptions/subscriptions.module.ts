import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { IngestClient } from './ingest.client.js';
import { SubscriptionsController } from './subscriptions.controller.js';

@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 20 }])],
  controllers: [SubscriptionsController],
  providers: [IngestClient],
  exports: [IngestClient],
})
export class SubscriptionsModule {}
