import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { ConfigService } from '@nestjs/config';

export type MessageHandler<T = unknown> = (
  message: T,
  channel: string,
) => void | Promise<void>;

@Injectable()
export class RedisSubscriberService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisSubscriberService.name);

  // Dedicated connection: once in subscribe mode it can't run other commands.
  private readonly redisSubscriber;

  private readonly channelHandlers = new Map<string, Set<MessageHandler>>();
  private readonly patternHandlers = new Map<string, Set<MessageHandler>>();

  constructor(private configService: ConfigService) {
    const redisUrl = this.configService.get<string>('REDIS_URL')!;
    this.redisSubscriber = new Redis(redisUrl, {
      // ioredis re-subscribes to all channels automatically after a reconnect.
      autoResubscribe: true,
      maxRetriesPerRequest: null,
    });
  }

  async onModuleInit() {
    this.redisSubscriber.on('connect', () =>
      this.logger.log('Connected to Redis'),
    );
    this.redisSubscriber.on('error', (err) =>
      this.logger.error(`Redis error: ${err.message}`),
    );

    // Exact channel subscriptions
    this.redisSubscriber.on('message', (channel, raw) => {
      this.dispatch(this.channelHandlers.get(channel), raw, channel);
    });

    // Pattern subscriptions, e.g. 'user.*'
    this.redisSubscriber.on('pmessage', (pattern, channel, raw) => {
      this.dispatch(this.patternHandlers.get(pattern), raw, channel);
    });
  }

  /** Subscribe to an exact channel. Returns a function that unsubscribes this handler. */
  async subscribe<T = unknown>(
    channel: string,
    handler: MessageHandler<T>,
  ): Promise<() => Promise<void>> {
    await this.addHandler(
      this.channelHandlers,
      channel,
      handler as MessageHandler,
      () => this.redisSubscriber.subscribe(channel),
    );
    return () =>
      this.removeHandler(
        this.channelHandlers,
        channel,
        handler as MessageHandler,
        () => this.redisSubscriber.unsubscribe(channel),
      );
  }

  /** Subscribe to a glob pattern such as 'orders.*'. Returns a function that unsubscribes this handler. */
  async psubscribe<T = unknown>(
    pattern: string,
    handler: MessageHandler<T>,
  ): Promise<() => Promise<void>> {
    await this.addHandler(
      this.patternHandlers,
      pattern,
      handler as MessageHandler,
      () => this.redisSubscriber.psubscribe(pattern),
    );
    return () =>
      this.removeHandler(
        this.patternHandlers,
        pattern,
        handler as MessageHandler,
        () => this.redisSubscriber.punsubscribe(pattern),
      );
  }

  async onModuleDestroy() {
    await this.redisSubscriber.quit();
  }

  private async addHandler(
    registry: Map<string, Set<MessageHandler>>,
    key: string,
    handler: MessageHandler,
    redisSubscribe: () => Promise<unknown>,
  ) {
    let handlers = registry.get(key);
    if (!handlers) {
      handlers = new Set();
      registry.set(key, handlers);
      await redisSubscribe();
      this.logger.log(`Subscribed to ${key}`);
    }
    handlers.add(handler);
  }

  private async removeHandler(
    registry: Map<string, Set<MessageHandler>>,
    key: string,
    handler: MessageHandler,
    redisUnsubscribe: () => Promise<unknown>,
  ) {
    const handlers = registry.get(key);
    if (!handlers) return;
    handlers.delete(handler);
    if (handlers.size === 0) {
      registry.delete(key);
      await redisUnsubscribe();
      this.logger.log(`Unsubscribed from ${key}`);
    }
  }

  private dispatch(
    handlers: Set<MessageHandler> | undefined,
    raw: string,
    channel: string,
  ) {
    if (!handlers?.size) return;

    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      message = raw; // not JSON, pass the raw string through
    }

    for (const handler of handlers) {
      // One failing handler shouldn't break the others or crash the listener.
      Promise.resolve(handler(message, channel)).catch((err) =>
        this.logger.error(
          `Handler for "${channel}" failed: ${err?.message ?? err}`,
        ),
      );
    }
  }
}
