import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import {
  isValidSymbol,
  type SubscribeError,
  type SubscribeResponse,
  type SubscriptionErrorCode,
} from '@repo/shared';
import { IngestClient } from './ingest.client.js';

const STATUS: Record<SubscriptionErrorCode, HttpStatus> = {
  invalid: HttpStatus.BAD_REQUEST,
  unsupported: HttpStatus.UNPROCESSABLE_ENTITY,
  capacity: HttpStatus.CONFLICT,
  unavailable: HttpStatus.SERVICE_UNAVAILABLE,
};

@Controller('subscriptions')
@UseGuards(ThrottlerGuard)
// Each accepted call fans out to ingest (and possibly the upstream feed)
@Throttle({ default: { limit: 20, ttl: 60_000 } })
export class SubscriptionsController {
  constructor(private readonly ingest: IngestClient) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async subscribe(@Body() body: unknown): Promise<SubscribeResponse> {
    const symbol = (body as { symbol?: unknown } | null | undefined)?.symbol;
    if (!isValidSymbol(symbol)) {
      throw this.refuse('invalid');
    }
    const result = await this.ingest.subscribe(symbol);
    if (!result.ok) {
      throw this.refuse(result.error);
    }
    return { symbol };
  }

  private refuse(error: SubscriptionErrorCode): HttpException {
    const body: SubscribeError = { error };
    return new HttpException(body, STATUS[error]);
  }
}
