import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { quoteKey, TICK_CHANNEL_PATTERN, type RedisTick } from '@repo/shared';
import { BehaviorSubject, Observable, Subject } from 'rxjs';
import { distinctUntilChanged } from 'rxjs/operators';
import { APP_CONFIG, type AppConfig } from '../config.js';
import {
  parseRedisTick,
  parseTickMessage,
  truncatePayload,
  type ParseFailure,
  type ParsedTick,
} from './parse-tick.js';
import {
  REDIS_FACTORY,
  type RedisClient,
  type RedisFactory,
  type RedisRole,
} from './redis.tokens.js';

export type RedisStatus = 'connecting' | 'ready' | 'down';

export const BOOT_TIMEOUT_MS = 5_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;
const WARN_INTERVAL_MS = 10_000;
export const SUMMARY_INTERVAL_MS = 10_000;

/**
 * Subscribes once to ticks:* and fans valid ticks out in-process.
 *
 * Fan-out is synchronous and unbuffered: slow-client backpressure belongs to
 * the consumer. A consumer that throws inside its `next` handler is reported
 * by rxjs as an uncaught exception, so consumers must catch their own errors.
 *
 * Redis pub/sub is at-most-once: ticks published while the subscriber is
 * disconnected are lost. Re-read getQuote() whenever `status$` returns to
 * 'ready'. To combine a snapshot with live ticks, subscribe to ticksFor()
 * first (buffering), then await getQuote(), then flush the buffer.
 */
@Injectable()
export class TickSubscriberService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(TickSubscriberService.name);
  private readonly tickSubject = new Subject<ParsedTick>();
  private readonly symbolSubjects = new Map<string, Subject<RedisTick>>();
  private readonly statusSubject = new BehaviorSubject<RedisStatus>(
    'connecting',
  );
  private readonly ready: Record<RedisRole, boolean> = {
    subscriber: false,
    command: false,
  };
  private readonly errorLogged: Record<RedisRole, boolean> = {
    subscriber: false,
    command: false,
  };
  private readonly lastWarnAt = new Map<ParseFailure, number>();
  private readonly seenSymbols = new Set<string>();
  private readonly configuredSymbols: readonly string[];
  private readonly knownSymbols: ReadonlySet<string>;
  private everReady = false;
  private closed = false;
  private summaryTimer?: NodeJS.Timeout;
  /** Ticks since the last summary line, by symbol. */
  private readonly recent = new Map<string, { count: number; price: number }>();
  private subscriber?: RedisClient;
  private commands?: RedisClient;

  /** Every valid tick on ticks:*. Hot, no replay; completes on shutdown. */
  readonly ticks$: Observable<ParsedTick> = this.tickSubject.asObservable();
  /** 'ready' only while both connections are; re-emits on every reconnect. */
  readonly status$: Observable<RedisStatus> = this.statusSubject.pipe(
    distinctUntilChanged(),
  );
  readonly stats: { received: number; dropped: number; lastTickAt?: number } = {
    received: 0,
    dropped: 0,
  };

  constructor(
    @Inject(REDIS_FACTORY) private readonly createRedis: RedisFactory,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.configuredSymbols = config.symbols;
    this.knownSymbols = new Set(config.symbols.map((s) => s.toLowerCase()));
  }

  /** Hot stream for one symbol (case-insensitive). */
  ticksFor(symbol: string): Observable<RedisTick> {
    return this.symbolSubject(symbol.toLowerCase()).asObservable();
  }

  /** Latest cached quote for the exact (canonical) symbol, or null. */
  async getQuote(symbol: string): Promise<RedisTick | null> {
    if (this.closed || !this.commands) {
      throw new Error('Tick subscriber is not running');
    }
    const raw = await this.commands.get(quoteKey(symbol));
    if (raw === null) {
      return null;
    }
    const tick = parseRedisTick(raw);
    if (!tick) {
      this.logger.warn(
        `Unparsable cached quote for ${symbol}: ${truncatePayload(raw)}`,
      );
      return null;
    }
    return tick;
  }

  /** Fails fast if Redis is unreachable at startup. */
  async onModuleInit(): Promise<void> {
    const subscriber = this.createRedis('subscriber');
    const commands = this.createRedis('command');
    this.subscriber = subscriber;
    this.commands = commands;
    this.watch('subscriber', subscriber);
    this.watch('command', commands);
    subscriber.on(
      'pmessage',
      (_pattern: string, channel: string, message: string) => {
        this.handleMessage(channel, message);
      },
    );

    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        (async () => {
          await Promise.all([subscriber.connect(), commands.connect()]);
          // ioredis re-issues this PSUBSCRIBE on every reconnect
          await subscriber.psubscribe(TICK_CHANNEL_PATTERN);
        })(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`timed out after ${BOOT_TIMEOUT_MS}ms`)),
            BOOT_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (error) {
      this.closed = true;
      this.subscriber = undefined;
      this.commands = undefined;
      subscriber.disconnect();
      commands.disconnect();
      this.logger.error(
        `Redis unreachable at startup: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new Error('Redis unreachable at startup');
    } finally {
      clearTimeout(timer);
    }
    this.logger.log(
      `Subscribed to ${TICK_CHANNEL_PATTERN} (SYMBOLS: ${this.configuredSymbols.join(', ')})`,
    );
    this.startSummary();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.closed && !this.subscriber) {
      return;
    }
    this.closed = true;
    clearInterval(this.summaryTimer);
    this.tickSubject.complete();
    for (const subject of this.symbolSubjects.values()) {
      subject.complete();
    }
    this.statusSubject.complete();

    const { subscriber, commands } = this;
    this.subscriber = undefined;
    this.commands = undefined;
    await Promise.allSettled([
      subscriber &&
        subscriber
          .punsubscribe()
          .catch(() => undefined)
          .then(() => close(subscriber)),
      commands && close(commands),
    ]);
  }

  private handleMessage(channel: string, payload: string): void {
    const result = parseTickMessage(channel, payload);
    if (!result.ok) {
      this.stats.dropped++;
      this.warnDropped(result.reason, channel, payload);
      return;
    }
    const { symbol, tick } = result.value;
    this.stats.received++;
    this.stats.lastTickAt = Date.now();
    this.noteSymbol(symbol);
    const entry = this.recent.get(symbol) ?? { count: 0, price: tick.price };
    entry.count++;
    entry.price = tick.price;
    this.recent.set(symbol, entry);
    this.tickSubject.next(result.value);
    this.symbolSubjects.get(symbol.toLowerCase())?.next(tick);
  }

  /** Quiet when idle; otherwise one line per interval so activity is visible. */
  private startSummary(): void {
    this.summaryTimer = setInterval(() => {
      if (this.recent.size === 0) {
        return;
      }
      const parts = [...this.recent].map(
        ([symbol, { count, price }]) => `${symbol} x${count} (last ${price})`,
      );
      this.recent.clear();
      this.logger.log(
        `Ticks in the last ${SUMMARY_INTERVAL_MS / 1000}s: ${parts.join(', ')}`,
      );
    }, SUMMARY_INTERVAL_MS);
    this.summaryTimer.unref();
  }

  private watch(role: RedisRole, client: RedisClient): void {
    client.on('error', (error: Error) => {
      // The retry loop repeats the same error; log it once per outage
      if (!this.errorLogged[role]) {
        this.errorLogged[role] = true;
        this.logger.error(`Redis ${role} error: ${error.message}`);
      }
    });
    client.on('ready', () => {
      this.errorLogged[role] = false;
      this.ready[role] = true;
      this.logger.log(`Redis ${role} ready`);
      this.publishStatus();
    });
    for (const event of ['close', 'end'] as const) {
      client.on(event, () => {
        this.ready[role] = false;
        this.publishStatus();
      });
    }
  }

  private publishStatus(): void {
    if (this.closed) {
      return;
    }
    if (this.ready.subscriber && this.ready.command) {
      this.everReady = true;
      this.statusSubject.next('ready');
    } else {
      this.statusSubject.next(this.everReady ? 'down' : 'connecting');
    }
  }

  private symbolSubject(key: string): Subject<RedisTick> {
    let subject = this.symbolSubjects.get(key);
    if (!subject) {
      subject = new Subject<RedisTick>();
      this.symbolSubjects.set(key, subject);
    }
    return subject;
  }

  /** Logs each symbol the first time a tick arrives; flags ones outside SYMBOLS. */
  private noteSymbol(symbol: string): void {
    if (this.seenSymbols.has(symbol)) {
      return;
    }
    this.seenSymbols.add(symbol);
    if (this.knownSymbols.has(symbol.toLowerCase())) {
      this.logger.log(`Receiving ticks for ${symbol}`);
    } else {
      this.logger.warn(
        `Receiving ticks for ${symbol}, which is not in SYMBOLS`,
      );
    }
  }

  private warnDropped(
    reason: ParseFailure,
    channel: string,
    payload: string,
  ): void {
    const now = Date.now();
    if (now - (this.lastWarnAt.get(reason) ?? 0) < WARN_INTERVAL_MS) {
      return;
    }
    this.lastWarnAt.set(reason, now);
    this.logger.warn(
      `Dropped tick (${reason}) on ${channel}: ${truncatePayload(payload)}`,
    );
  }
}

async function close(client: RedisClient): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.quit(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('quit timed out')),
          SHUTDOWN_TIMEOUT_MS,
        );
      }),
    ]);
  } catch {
    client.disconnect();
  } finally {
    clearTimeout(timer);
  }
}
