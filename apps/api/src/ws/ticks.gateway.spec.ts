import { EventEmitter } from 'node:events';
import type { RedisTick, ServerMessage } from '@repo/shared';
import { BehaviorSubject, Subject } from 'rxjs';
import type { WebSocket } from 'ws';
import type { AppConfig } from '../config.js';
import type {
  RedisStatus,
  TickSubscriberService,
} from '../redis/tick-subscriber.service.js';
import {
  MAX_BUFFERED_BYTES,
  MAX_SYMBOLS_PER_CONNECTION,
  TicksGateway,
} from './ticks.gateway.js';

class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: ServerMessage[] = [];
  send = vi.fn((data: string) => {
    this.sent.push(JSON.parse(data) as ServerMessage);
  });
  close = vi.fn();
  terminate = vi.fn();

  frame(payload: unknown, isBinary = false): void {
    const data =
      typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.emit('message', Buffer.from(data), isBinary);
  }
  types(): string[] {
    return this.sent.map((m) => m.type);
  }
  errors() {
    return this.sent.flatMap((m) => (m.type === 'error' ? [m] : []));
  }
}

const tick = (symbol: string, timestamp: number, price = 1): RedisTick => ({
  symbol,
  timestamp,
  price,
  ingestedAt: timestamp * 1000,
});

class FakeSubscriber {
  readonly streams = new Map<string, Subject<RedisTick>>();
  readonly status = new BehaviorSubject<RedisStatus>('ready');
  status$ = this.status.asObservable();
  getQuote = vi.fn(async (_symbol: string): Promise<RedisTick | null> => null);
  ticksFor = vi.fn((symbol: string) => this.stream(symbol).asObservable());

  stream(symbol: string): Subject<RedisTick> {
    const key = symbol.toLowerCase();
    let subject = this.streams.get(key);
    if (!subject) {
      subject = new Subject();
      this.streams.set(key, subject);
    }
    return subject;
  }
}

const config: AppConfig = {
  redisUrl: 'redis://localhost:6379',
  symbols: ['AAPL', 'EUR/USD', 'BRK.B', 'A', 'B', 'C', 'D', 'E', 'F'],
  port: 3002,
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A getQuote result the test resolves by hand. */
function deferredQuote(subscriber: FakeSubscriber) {
  let resolve!: (tick: RedisTick | null) => void;
  subscriber.getQuote.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  return (tick: RedisTick | null) => resolve(tick);
}

function setup(symbols = config.symbols) {
  const subscriber = new FakeSubscriber();
  const gateway = new TicksGateway(
    subscriber as unknown as TickSubscriberService,
    { ...config, symbols },
  );
  gateway.onModuleInit();
  const connect = () => {
    const socket = new FakeSocket();
    gateway.handleConnection(socket as unknown as WebSocket);
    return socket;
  };
  return { subscriber, gateway, connect };
}

const asWs = (socket: FakeSocket) => socket as unknown as WebSocket;

describe('TicksGateway', () => {
  describe('validation', () => {
    it.each([
      ['non-JSON', 'not json{'],
      ['unknown type', { type: 'nope' }],
      ['empty symbols', { type: 'subscribe', symbols: [] }],
      ['glob symbol', { type: 'subscribe', symbols: ['*'] }],
      ['too many symbols', { type: 'subscribe', symbols: Array(9).fill('A') }],
      ['array', []],
    ])('rejects %s with invalid_message', async (_name, payload) => {
      const { connect } = setup();
      const socket = connect();
      socket.frame(payload);
      await flush();
      expect(socket.errors()).toMatchObject([{ code: 'invalid_message' }]);
    });

    it('rejects binary frames and keeps the connection usable', async () => {
      const { connect, subscriber } = setup();
      const socket = connect();
      socket.frame({ type: 'subscribe', symbols: ['AAPL'] }, true);
      await flush();
      expect(socket.errors()).toMatchObject([{ code: 'invalid_message' }]);
      socket.frame({ type: 'subscribe', symbols: ['AAPL'] });
      await flush();
      expect(subscriber.ticksFor).toHaveBeenCalledWith('AAPL');
    });
  });

  describe('subscribe', () => {
    it('matches the allow-list case-insensitively and uses canonical casing', async () => {
      const { connect, subscriber } = setup();
      subscriber.getQuote.mockResolvedValue(tick('EUR/USD', 10));
      const socket = connect();
      socket.frame({ type: 'subscribe', symbols: ['eur/usd'] });
      await flush();
      expect(subscriber.getQuote).toHaveBeenCalledWith('EUR/USD');
      expect(socket.sent).toEqual([
        { type: 'snapshot', symbol: 'EUR/USD', tick: tick('EUR/USD', 10) },
        { type: 'subscribed', symbols: ['EUR/USD'] },
      ]);
    });

    it('rejects unknown symbols but still handles the valid ones', async () => {
      const { connect } = setup();
      const socket = connect();
      socket.frame({ type: 'subscribe', symbols: ['TSLA', 'AAPL'] });
      await flush();
      expect(socket.errors()).toEqual([
        {
          type: 'error',
          code: 'unknown_symbol',
          message: 'Unknown symbol: TSLA',
          symbol: 'TSLA',
        },
      ]);
      expect(socket.sent.at(-1)).toEqual({
        type: 'subscribed',
        symbols: ['AAPL'],
      });
    });

    it('sends a null snapshot when nothing is cached', async () => {
      const { connect } = setup();
      const socket = connect();
      socket.frame({ type: 'subscribe', symbols: ['AAPL'] });
      await flush();
      expect(socket.sent[0]).toEqual({
        type: 'snapshot',
        symbol: 'AAPL',
        tick: null,
      });
    });

    it('falls back to the uppercase key when canonical casing has no quote', async () => {
      const { connect, subscriber } = setup(['Brk.b']);
      subscriber.getQuote.mockImplementation(async (symbol) =>
        symbol === 'BRK.B' ? tick('BRK.B', 5) : null,
      );
      const socket = connect();
      socket.frame({ type: 'subscribe', symbols: ['brk.b'] });
      await flush();
      expect(subscriber.getQuote.mock.calls).toEqual([['Brk.b'], ['BRK.B']]);
      expect(socket.sent[0]).toMatchObject({
        type: 'snapshot',
        symbol: 'Brk.b',
        tick: { timestamp: 5 },
      });
    });

    it('does not repeat the GET when canonical casing is already uppercase', async () => {
      const { connect, subscriber } = setup();
      connect().frame({ type: 'subscribe', symbols: ['AAPL'] });
      await flush();
      expect(subscriber.getQuote).toHaveBeenCalledTimes(1);
    });

    it('is idempotent for already-subscribed symbols', async () => {
      const { connect, subscriber } = setup();
      const socket = connect();
      socket.frame({ type: 'subscribe', symbols: ['AAPL'] });
      await flush();
      socket.sent.length = 0;
      socket.frame({ type: 'subscribe', symbols: ['aapl'] });
      await flush();
      expect(subscriber.ticksFor).toHaveBeenCalledTimes(1);
      expect(subscriber.getQuote).toHaveBeenCalledTimes(1);
      expect(socket.sent).toEqual([{ type: 'subscribed', symbols: ['AAPL'] }]);
      subscriber.stream('AAPL').next(tick('AAPL', 20));
      expect(socket.types()).toEqual(['subscribed', 'tick']);
    });

    it('caps symbols per connection', async () => {
      const { connect } = setup();
      const socket = connect();
      socket.frame({
        type: 'subscribe',
        symbols: ['AAPL', 'EUR/USD', 'BRK.B', 'A', 'B', 'C', 'D', 'E'],
      });
      await flush();
      expect(socket.errors()).toEqual([]);
      socket.sent.length = 0;
      socket.frame({ type: 'subscribe', symbols: ['F'] });
      await flush();
      expect(socket.types()).toEqual(['error']);
      expect(socket.errors()).toMatchObject([{ code: 'too_many_symbols' }]);
      // existing ones stay idempotent at the cap
      socket.sent.length = 0;
      socket.frame({ type: 'subscribe', symbols: ['AAPL'] });
      await flush();
      expect(socket.sent).toEqual([{ type: 'subscribed', symbols: ['AAPL'] }]);
      expect(MAX_SYMBOLS_PER_CONNECTION).toBe(8);
    });

    it('counts pending subscribes against the cap', async () => {
      const { connect, subscriber } = setup();
      subscriber.getQuote.mockReturnValue(new Promise(() => undefined));
      const socket = connect();
      socket.frame({
        type: 'subscribe',
        symbols: ['AAPL', 'EUR/USD', 'BRK.B', 'A', 'B', 'C', 'D', 'E'],
      });
      socket.frame({ type: 'subscribe', symbols: ['F'] });
      await flush();
      expect(socket.errors()).toMatchObject([{ code: 'too_many_symbols' }]);
    });
  });

  describe('snapshot then live', () => {
    it('streams ticks after the snapshot, in order', async () => {
      const { connect, subscriber } = setup();
      subscriber.getQuote.mockResolvedValue(tick('AAPL', 10, 100));
      const socket = connect();
      socket.frame({ type: 'subscribe', symbols: ['AAPL'] });
      await flush();
      subscriber.stream('AAPL').next(tick('AAPL', 11, 101));
      expect(socket.types()).toEqual(['snapshot', 'subscribed', 'tick']);
      expect(socket.sent[2]).toEqual({
        type: 'tick',
        symbol: 'AAPL',
        tick: tick('AAPL', 11, 101),
      });
    });

    it('subscribes to the live stream before reading the quote', async () => {
      const { connect, subscriber } = setup();
      const order: string[] = [];
      subscriber.ticksFor.mockImplementation((symbol) => {
        order.push('ticksFor');
        return subscriber.stream(symbol).asObservable();
      });
      subscriber.getQuote.mockImplementation(async () => {
        order.push('getQuote');
        return null;
      });
      connect().frame({ type: 'subscribe', symbols: ['AAPL'] });
      await flush();
      expect(order).toEqual(['ticksFor', 'getQuote']);
    });

    it('buffers ticks arriving during the GET and drops stale ones', async () => {
      const { connect, subscriber } = setup();
      const resolve = deferredQuote(subscriber);
      const socket = connect();
      socket.frame({ type: 'subscribe', symbols: ['AAPL'] });
      await flush();
      const stream = subscriber.stream('AAPL');
      stream.next(tick('AAPL', 9)); // older than the snapshot
      stream.next(tick('AAPL', 10)); // same second as the snapshot
      stream.next(tick('AAPL', 12));
      expect(socket.sent).toEqual([]);
      resolve(tick('AAPL', 10));
      await flush();
      expect(socket.sent).toEqual([
        { type: 'snapshot', symbol: 'AAPL', tick: tick('AAPL', 10) },
        { type: 'tick', symbol: 'AAPL', tick: tick('AAPL', 10) },
        { type: 'tick', symbol: 'AAPL', tick: tick('AAPL', 12) },
        { type: 'subscribed', symbols: ['AAPL'] },
      ]);
    });

    it('flushes every buffered tick when the snapshot is null', async () => {
      const { connect, subscriber } = setup();
      const resolve = deferredQuote(subscriber);
      const socket = connect();
      socket.frame({ type: 'subscribe', symbols: ['AAPL'] });
      await flush();
      subscriber.stream('AAPL').next(tick('AAPL', 1));
      resolve(null);
      await flush();
      expect(socket.types()).toEqual(['snapshot', 'tick', 'subscribed']);
    });

    it('does not leak other symbols or clients', async () => {
      const { connect, subscriber } = setup();
      const a = connect();
      const b = connect();
      a.frame({ type: 'subscribe', symbols: ['AAPL'] });
      b.frame({ type: 'subscribe', symbols: ['EUR/USD'] });
      await flush();
      subscriber.stream('AAPL').next(tick('AAPL', 5));
      expect(a.types()).toEqual(['snapshot', 'subscribed', 'tick']);
      expect(b.types()).toEqual(['snapshot', 'subscribed']);
    });
  });

  describe('getQuote failure', () => {
    it('reports internal and leaves no subscription behind', async () => {
      const { connect, subscriber } = setup();
      subscriber.getQuote.mockRejectedValue(new Error('redis down'));
      const socket = connect();
      socket.frame({ type: 'subscribe', symbols: ['AAPL', 'EUR/USD'] });
      await flush();
      expect(socket.errors()).toEqual([
        {
          type: 'error',
          code: 'internal',
          message: 'Could not load AAPL',
          symbol: 'AAPL',
        },
        {
          type: 'error',
          code: 'internal',
          message: 'Could not load EUR/USD',
          symbol: 'EUR/USD',
        },
      ]);
      expect(socket.types()).not.toContain('subscribed');
      expect(subscriber.stream('AAPL').observed).toBe(false);
      // a retry works and the slot was freed
      subscriber.getQuote.mockResolvedValue(null);
      socket.frame({ type: 'subscribe', symbols: ['AAPL'] });
      await flush();
      expect(socket.sent.at(-1)).toEqual({
        type: 'subscribed',
        symbols: ['AAPL'],
      });
    });
  });

  describe('unsubscribe', () => {
    it('stops delivering ticks and frees the slot', async () => {
      const { connect, subscriber } = setup();
      const socket = connect();
      socket.frame({ type: 'subscribe', symbols: ['AAPL'] });
      await flush();
      socket.frame({ type: 'unsubscribe', symbols: ['aapl', 'TSLA'] });
      await flush();
      socket.sent.length = 0;
      expect(subscriber.stream('AAPL').observed).toBe(false);
      subscriber.stream('AAPL').next(tick('AAPL', 5));
      expect(socket.sent).toEqual([]);
      socket.frame({ type: 'subscribe', symbols: ['AAPL'] });
      await flush();
      expect(socket.types()).toEqual(['snapshot', 'subscribed']);
    });

    it('drops an in-flight subscribe without sending a snapshot', async () => {
      const { connect, subscriber } = setup();
      const resolve = deferredQuote(subscriber);
      const socket = connect();
      socket.frame({ type: 'subscribe', symbols: ['AAPL'] });
      await flush();
      socket.frame({ type: 'unsubscribe', symbols: ['AAPL'] });
      resolve(tick('AAPL', 1));
      await flush();
      expect(socket.sent).toEqual([]);
      expect(subscriber.stream('AAPL').observed).toBe(false);
    });
  });

  describe('disconnect', () => {
    it('releases every per-client subscription', async () => {
      const { connect, gateway, subscriber } = setup();
      const socket = connect();
      socket.frame({ type: 'subscribe', symbols: ['AAPL', 'EUR/USD'] });
      await flush();
      expect(subscriber.stream('AAPL').observed).toBe(true);
      gateway.handleDisconnect(asWs(socket));
      expect(subscriber.stream('AAPL').observed).toBe(false);
      expect(subscriber.stream('EUR/USD').observed).toBe(false);
    });

    it('cleans up when disconnecting mid-subscribe', async () => {
      const { connect, gateway, subscriber } = setup();
      const resolve = deferredQuote(subscriber);
      const socket = connect();
      socket.frame({ type: 'subscribe', symbols: ['AAPL'] });
      await flush();
      gateway.handleDisconnect(asWs(socket));
      resolve(null);
      await flush();
      expect(socket.sent).toEqual([]);
      expect(subscriber.stream('AAPL').observed).toBe(false);
    });

    it('releases everything on module destroy', async () => {
      const { connect, gateway, subscriber } = setup();
      connect().frame({ type: 'subscribe', symbols: ['AAPL'] });
      await flush();
      gateway.onModuleDestroy();
      expect(subscriber.stream('AAPL').observed).toBe(false);
      expect(subscriber.status.observed).toBe(false);
    });
  });

  describe('redis reconnect', () => {
    it('re-sends a fresh snapshot per subscribed symbol after down -> ready', async () => {
      const { connect, subscriber } = setup();
      const socket = connect();
      socket.frame({ type: 'subscribe', symbols: ['AAPL', 'EUR/USD'] });
      await flush();
      socket.sent.length = 0;

      subscriber.status.next('down');
      await flush();
      expect(socket.sent).toEqual([]);

      subscriber.getQuote.mockImplementation(async (symbol) =>
        tick(symbol, 99),
      );
      subscriber.status.next('ready');
      await flush();
      expect(socket.sent).toEqual([
        { type: 'snapshot', symbol: 'AAPL', tick: tick('AAPL', 99) },
        { type: 'snapshot', symbol: 'EUR/USD', tick: tick('EUR/USD', 99) },
      ]);
      subscriber.stream('AAPL').next(tick('AAPL', 100));
      expect(socket.sent.at(-1)).toMatchObject({ type: 'tick' });
    });

    it('does not re-snapshot on the first connecting -> ready', async () => {
      const subscriber = new FakeSubscriber();
      subscriber.status.next('connecting');
      const gateway = new TicksGateway(
        subscriber as unknown as TickSubscriberService,
        config,
      );
      gateway.onModuleInit();
      const socket = new FakeSocket();
      gateway.handleConnection(asWs(socket));
      socket.frame({ type: 'subscribe', symbols: ['AAPL'] });
      await flush();
      socket.sent.length = 0;
      subscriber.status.next('ready');
      await flush();
      expect(socket.sent).toEqual([]);
    });

    it('buffers live ticks during the re-snapshot and drops stale ones', async () => {
      const { connect, subscriber } = setup();
      const socket = connect();
      socket.frame({ type: 'subscribe', symbols: ['AAPL'] });
      await flush();
      socket.sent.length = 0;
      const resolve = deferredQuote(subscriber);
      subscriber.status.next('down');
      subscriber.status.next('ready');
      subscriber.stream('AAPL').next(tick('AAPL', 5));
      subscriber.stream('AAPL').next(tick('AAPL', 8));
      resolve(tick('AAPL', 7));
      await flush();
      expect(socket.sent).toEqual([
        { type: 'snapshot', symbol: 'AAPL', tick: tick('AAPL', 7) },
        { type: 'tick', symbol: 'AAPL', tick: tick('AAPL', 8) },
      ]);
    });

    it('reports internal but keeps streaming when the re-snapshot fails', async () => {
      const { connect, subscriber } = setup();
      const socket = connect();
      socket.frame({ type: 'subscribe', symbols: ['AAPL'] });
      await flush();
      socket.sent.length = 0;
      subscriber.getQuote.mockRejectedValue(new Error('boom'));
      subscriber.status.next('down');
      subscriber.status.next('ready');
      await flush();
      expect(socket.errors()).toMatchObject([
        { code: 'internal', symbol: 'AAPL' },
      ]);
      subscriber.stream('AAPL').next(tick('AAPL', 5));
      expect(socket.sent.at(-1)).toMatchObject({ type: 'tick' });
    });
  });

  describe('slow and closed clients', () => {
    it('does not send to a socket that is not open', async () => {
      const { connect, subscriber } = setup();
      const socket = connect();
      socket.frame({ type: 'subscribe', symbols: ['AAPL'] });
      await flush();
      socket.send.mockClear();
      socket.readyState = 2;
      subscriber.stream('AAPL').next(tick('AAPL', 5));
      expect(socket.send).not.toHaveBeenCalled();
    });

    it('terminates a client whose buffer grows unbounded and cleans up', async () => {
      const { connect, subscriber } = setup();
      const socket = connect();
      socket.frame({ type: 'subscribe', symbols: ['AAPL'] });
      await flush();
      socket.bufferedAmount = MAX_BUFFERED_BYTES + 1;
      subscriber.stream('AAPL').next(tick('AAPL', 5));
      expect(socket.terminate).toHaveBeenCalledTimes(1);
      expect(subscriber.stream('AAPL').observed).toBe(false);
    });

    it('survives a throwing socket.send', async () => {
      const { connect, subscriber } = setup();
      const socket = connect();
      socket.frame({ type: 'subscribe', symbols: ['AAPL'] });
      await flush();
      socket.send.mockImplementation(() => {
        throw new Error('EPIPE');
      });
      expect(() =>
        subscriber.stream('AAPL').next(tick('AAPL', 5)),
      ).not.toThrow();
    });
  });
});
