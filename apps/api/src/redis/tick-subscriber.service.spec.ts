import { EventEmitter } from 'node:events';
import { Test } from '@nestjs/testing';
import { TICK_CHANNEL_PATTERN, type RedisTick } from '@repo/shared';
import { config as rxjsConfig } from 'rxjs';
import { APP_CONFIG, type AppConfig } from '../config.js';
import {
  REDIS_FACTORY,
  type RedisClient,
  type RedisRole,
} from './redis.tokens.js';
import {
  BOOT_TIMEOUT_MS,
  SUMMARY_INTERVAL_MS,
  TickSubscriberService,
  type RedisStatus,
} from './tick-subscriber.service.js';

class FakeRedis extends EventEmitter {
  connect = vi.fn(async () => undefined);
  psubscribe = vi.fn(async (..._patterns: string[]) => 1);
  punsubscribe = vi.fn(async () => 0);
  get = vi.fn(async (_key: string): Promise<string | null> => null);
  quit = vi.fn(async () => 'OK');
  disconnect = vi.fn();
}

const config: AppConfig = {
  redisUrl: 'redis://localhost:6379',
  symbols: ['AAPL', 'EUR/USD'],
  port: 3002,
};

const tick = (symbol: string, price = 1) => ({
  symbol,
  timestamp: 1,
  price,
  ingestedAt: 2,
});

describe('TickSubscriberService', () => {
  let clients: Record<RedisRole, FakeRedis>;
  let service: TickSubscriberService;

  const publish = (channel: string, payload: string) =>
    clients.subscriber.emit('pmessage', 'ticks:*', channel, payload);

  beforeEach(() => {
    clients = { subscriber: new FakeRedis(), command: new FakeRedis() };
    service = new TickSubscriberService(
      (role) => clients[role] as unknown as RedisClient,
      config,
    );
    vi.spyOn(service['logger'], 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('startup', () => {
    it('connects both clients and psubscribes the tick pattern once', async () => {
      await service.onModuleInit();
      expect(clients.subscriber.connect).toHaveBeenCalledTimes(1);
      expect(clients.command.connect).toHaveBeenCalledTimes(1);
      expect(clients.subscriber.psubscribe).toHaveBeenCalledExactlyOnceWith(
        TICK_CHANNEL_PATTERN,
      );
      expect(clients.command.psubscribe).not.toHaveBeenCalled();
    });

    it('does not psubscribe again when the client re-emits ready', async () => {
      await service.onModuleInit();
      clients.subscriber.emit('ready');
      clients.subscriber.emit('ready');
      expect(clients.subscriber.psubscribe).toHaveBeenCalledTimes(1);
    });

    it('fails fast and disconnects when connect rejects', async () => {
      clients.subscriber.connect.mockRejectedValueOnce(
        new Error('ECONNREFUSED'),
      );
      await expect(service.onModuleInit()).rejects.toThrow(
        'Redis unreachable at startup',
      );
      expect(clients.subscriber.disconnect).toHaveBeenCalled();
      expect(clients.command.disconnect).toHaveBeenCalled();
    });

    it('fails fast when psubscribe never resolves', async () => {
      vi.useFakeTimers();
      clients.subscriber.psubscribe.mockReturnValueOnce(new Promise(() => {}));
      const result = expect(service.onModuleInit()).rejects.toThrow(
        'Redis unreachable at startup',
      );
      await vi.advanceTimersByTimeAsync(BOOT_TIMEOUT_MS);
      await result;
      expect(clients.subscriber.disconnect).toHaveBeenCalled();
      expect(clients.command.disconnect).toHaveBeenCalled();
    });

    it('shutdown after a failed boot is a no-op', async () => {
      clients.subscriber.connect.mockRejectedValueOnce(new Error('boom'));
      await service.onModuleInit().catch(() => undefined);
      await service.onApplicationShutdown();
      expect(clients.subscriber.quit).not.toHaveBeenCalled();
    });
  });

  describe('fan-out', () => {
    beforeEach(() => service.onModuleInit());

    it.each(['AAPL', 'RY:TSX', 'EUR/USD', 'BRK.B'])(
      'emits ticks for %s on ticks$ and ticksFor (case-insensitive)',
      (symbol) => {
        const all: string[] = [];
        const own: RedisTick[] = [];
        service.ticks$.subscribe((t) => all.push(t.symbol));
        service.ticksFor(symbol.toLowerCase()).subscribe((t) => own.push(t));
        publish(`ticks:${symbol}`, JSON.stringify(tick(symbol, 5)));
        publish('ticks:OTHER', JSON.stringify(tick('OTHER')));
        expect(all).toEqual([symbol, 'OTHER']);
        expect(own).toMatchObject([{ symbol, price: 5 }]);
      },
    );

    it('drops malformed messages and counts them', () => {
      const seen: string[] = [];
      service.ticks$.subscribe((t) => seen.push(t.symbol));
      publish('ticks:AAPL', 'garbage');
      publish('ticks:AAPL', '{"symbol":"AAPL"}');
      publish('other:AAPL', JSON.stringify(tick('AAPL')));
      publish('ticks:AAPL', JSON.stringify(tick('AAPL')));
      expect(seen).toEqual(['AAPL']);
      expect(service.stats).toMatchObject({ received: 1, dropped: 3 });
      expect(service.stats.lastTickAt).toBeTypeOf('number');
    });

    it('keeps delivering to other subscribers when one throws', async () => {
      const original = rxjsConfig.onUnhandledError;
      const errors: unknown[] = [];
      rxjsConfig.onUnhandledError = (error) => errors.push(error);
      try {
        const seen: number[] = [];
        service.ticksFor('AAPL').subscribe(() => {
          throw new Error('consumer bug');
        });
        service.ticksFor('AAPL').subscribe((t) => seen.push(t.price));
        publish('ticks:AAPL', JSON.stringify(tick('AAPL', 3)));
        expect(seen).toEqual([3]);
        // rxjs reports consumer errors on a later timer tick
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(errors).toHaveLength(1);
      } finally {
        rxjsConfig.onUnhandledError = original;
      }
    });
  });

  describe('symbol visibility', () => {
    it('logs the subscription at startup and each new symbol once', async () => {
      const log = vi
        .spyOn(service['logger'], 'log')
        .mockImplementation(() => {});
      const warn = vi
        .spyOn(service['logger'], 'warn')
        .mockImplementation(() => {});
      await service.onModuleInit();
      expect(log).toHaveBeenCalledWith(
        'Subscribed to ticks:* (SYMBOLS: AAPL, EUR/USD)',
      );
      publish('ticks:eur/usd', JSON.stringify(tick('eur/usd')));
      publish('ticks:eur/usd', JSON.stringify(tick('eur/usd')));
      publish('ticks:BTC/USD', JSON.stringify(tick('BTC/USD')));
      expect(log).toHaveBeenCalledWith('Receiving ticks for eur/usd');
      expect(
        log.mock.calls.filter(([m]) => String(m).includes('eur/usd')),
      ).toHaveLength(1);
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        'Receiving ticks for BTC/USD, which is not in SYMBOLS',
      );
    });
  });

  describe('summary log', () => {
    it('logs per-symbol counts once per interval and stays quiet when idle', async () => {
      vi.useFakeTimers();
      await service.onModuleInit();
      const log = vi
        .spyOn(service['logger'], 'log')
        .mockImplementation(() => {});
      publish('ticks:BTC/USD', JSON.stringify(tick('BTC/USD', 100)));
      publish('ticks:BTC/USD', JSON.stringify(tick('BTC/USD', 101)));
      publish('ticks:AAPL', JSON.stringify(tick('AAPL', 5)));
      await vi.advanceTimersByTimeAsync(SUMMARY_INTERVAL_MS);
      const summaries = () =>
        log.mock.calls
          .map(([m]) => String(m))
          .filter((m) => m.startsWith('Ticks in'));
      expect(summaries()).toEqual([
        'Ticks in the last 10s: BTC/USD x2 (last 101), AAPL x1 (last 5)',
      ]);
      await vi.advanceTimersByTimeAsync(SUMMARY_INTERVAL_MS);
      expect(summaries()).toHaveLength(1);
      await service.onApplicationShutdown();
    });
  });

  describe('getQuote', () => {
    beforeEach(() => service.onModuleInit());

    it('reads quote:{symbol} through the command connection', async () => {
      clients.command.get.mockResolvedValueOnce(
        JSON.stringify(tick('EUR/USD', 1.1)),
      );
      expect((await service.getQuote('EUR/USD'))?.price).toBe(1.1);
      expect(clients.command.get).toHaveBeenCalledWith('quote:EUR/USD');
      expect(clients.subscriber.get).not.toHaveBeenCalled();
    });

    it('returns null on a miss or an unparsable value', async () => {
      expect(await service.getQuote('NOPE')).toBeNull();
      clients.command.get.mockResolvedValueOnce('{bad');
      expect(await service.getQuote('AAPL')).toBeNull();
    });

    it('rejects when Redis fails', async () => {
      clients.command.get.mockRejectedValueOnce(new Error('timeout'));
      await expect(service.getQuote('AAPL')).rejects.toThrow('timeout');
    });
  });

  describe('status$', () => {
    it('tracks both connections and re-emits ready after a reconnect', async () => {
      const seen: RedisStatus[] = [];
      service.status$.subscribe((s) => seen.push(s));
      await service.onModuleInit();
      clients.subscriber.emit('ready');
      expect(seen).toEqual(['connecting']);
      clients.command.emit('ready');
      clients.subscriber.emit('close');
      clients.subscriber.emit('ready');
      expect(seen).toEqual(['connecting', 'ready', 'down', 'ready']);
    });

    it('logs a repeated connection error once per outage', async () => {
      const spy = vi
        .spyOn(service['logger'], 'error')
        .mockImplementation(() => {});
      await service.onModuleInit();
      clients.subscriber.emit('error', new Error('ECONNREFUSED'));
      clients.subscriber.emit('error', new Error('ECONNREFUSED'));
      expect(spy).toHaveBeenCalledTimes(1);
      clients.subscriber.emit('ready');
      clients.subscriber.emit('error', new Error('ECONNRESET'));
      expect(spy).toHaveBeenCalledTimes(2);
    });
  });

  describe('shutdown', () => {
    beforeEach(() => service.onModuleInit());

    it('quits both connections, completes streams and is idempotent', async () => {
      let completed = 0;
      service.ticks$.subscribe({ complete: () => completed++ });
      service.ticksFor('AAPL').subscribe({ complete: () => completed++ });
      await service.onApplicationShutdown();
      await service.onApplicationShutdown();
      expect(completed).toBe(2);
      expect(clients.subscriber.punsubscribe).toHaveBeenCalledTimes(1);
      expect(clients.subscriber.quit).toHaveBeenCalledTimes(1);
      expect(clients.command.quit).toHaveBeenCalledTimes(1);
      await expect(service.getQuote('AAPL')).rejects.toThrow('not running');
    });

    it('falls back to disconnect when quit rejects', async () => {
      clients.command.quit.mockRejectedValueOnce(new Error('closed'));
      await service.onApplicationShutdown();
      expect(clients.command.disconnect).toHaveBeenCalled();
    });
  });

  it('resolves through Nest DI with a fake factory', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: APP_CONFIG, useValue: config },
        {
          provide: REDIS_FACTORY,
          useValue: (role: RedisRole) => clients[role],
        },
        TickSubscriberService,
      ],
    }).compile();
    expect(moduleRef.get(TickSubscriberService)).toBeInstanceOf(
      TickSubscriberService,
    );
  });
});
