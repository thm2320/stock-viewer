import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SUBSCRIPTION_ERRORS,
  type SubscribeRequest,
  type SubscriptionErrorCode,
} from '@repo/shared';

export type IngestResult =
  { ok: true } | { ok: false; error: SubscriptionErrorCode };

const TIMEOUT_MS = 5_000;

/** Statuses ingest answers with a SubscribeError the API passes through. */
const PASSTHROUGH: Record<number, SubscriptionErrorCode> = {
  400: 'invalid',
  422: 'unsupported',
  409: 'capacity',
};

@Injectable()
export class IngestClient {
  private readonly logger = new Logger(IngestClient.name);

  constructor(private readonly configService: ConfigService) {}

  /** Asks ingest to stream `symbol` (also refreshes its idle TTL). Never throws. */
  async subscribe(symbol: string): Promise<IngestResult> {
    const base = this.configService.get<string>('INGEST_URL')!;
    const token = this.configService.get<string>('INGEST_TOKEN')!;
    const body: SubscribeRequest = { symbol };

    let res: Response;
    try {
      res = await fetch(new URL('/subscriptions', base), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-ingest-token': token,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      this.logger.warn(
        `Ingest unreachable: ${err instanceof Error ? err.name : 'unknown error'}`,
      );
      return { ok: false, error: 'unavailable' };
    }

    if (res.ok) {
      return { ok: true };
    }
    const mapped = PASSTHROUGH[res.status];
    if (mapped) {
      return { ok: false, error: await this.errorCode(res, mapped) };
    }
    if (res.status === 401) {
      this.logger.error('Ingest rejected INGEST_TOKEN');
    } else {
      this.logger.warn(`Ingest responded ${res.status}`);
    }
    return { ok: false, error: 'unavailable' };
  }

  /** Status decides; the body code is only used if it is a known one. */
  private async errorCode(
    res: Response,
    fallback: SubscriptionErrorCode,
  ): Promise<SubscriptionErrorCode> {
    try {
      const { error } = (await res.json()) as { error?: unknown };
      return (SUBSCRIPTION_ERRORS as readonly unknown[]).includes(error)
        ? (error as SubscriptionErrorCode)
        : fallback;
    } catch {
      return fallback;
    }
  }
}
