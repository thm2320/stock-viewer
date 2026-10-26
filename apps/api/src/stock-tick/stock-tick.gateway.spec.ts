import type { Socket } from 'socket.io';
import type { RedisClientService } from '../redis/redis-client.service.js';
import type { RedisSubscriberService } from '../redis/redis-subscriber.service.js';
import type { IngestClient } from '../subscriptions/ingest.client.js';
import {
  KEEP_ALIVE_MS,
  MAX_ROOMS_PER_CLIENT,
  StockTickGateway,
} from './stock-tick.gateway.js';

const tick = { symbol: 'AAPL', price: 1, timestamp: 2, ingestedAt: 3 };

function setup() {
  const rooms = new Map<string, Set<string>>();
  const emit = vi.fn();
  const server = {
    to: vi.fn(() => ({ emit })),
    sockets: { adapter: { rooms } },
  };
  let onTick: (m: unknown, channel: string) => void = () => {};
  const subscriber = {
    psubscribe: vi.fn(async (_p: string, h: typeof onTick) => {
      onTick = h;
      return async () => {};
    }),
  };
  const redisClient = { getQuote: vi.fn().mockResolvedValue(undefined) };
  const ingest = { subscribe: vi.fn().mockResolvedValue({ ok: true }) };
  const gateway = new StockTickGateway(
    subscriber as unknown as RedisSubscriberService,
    redisClient as unknown as RedisClientService,
    ingest as unknown as IngestClient,
  );
  (gateway as unknown as { server: unknown }).server = server;

  const makeClient = (id = 'c1') => {
    const joined = new Set<string>([id]);
    return {
      id,
      rooms: joined,
      emit: vi.fn(),
      join: vi.fn(async (room: string) => {
        joined.add(room);
        if (!rooms.has(room)) {
          rooms.set(room, new Set());
        }
        rooms.get(room)!.add(id);
      }),
      leave: vi.fn(async (room: string) => {
        joined.delete(room);
        rooms.get(room)?.delete(id);
      }),
    };
  };
  return {
    gateway,
    server,
    emit,
    redisClient,
    ingest,
    makeClient,
    sendTick: (m: unknown, c: string) => onTick(m, c),
  };
}

describe('StockTickGateway', () => {
  afterEach(() => vi.useRealTimers());

  describe('subscribe / unsubscribe', () => {
    it.each([
      undefined,
      {},
      { symbol: 1 },
      { symbol: '' },
      { symbol: 'A*' },
      { symbol: 'x'.repeat(33) },
    ])('rejects invalid body %j', async (body) => {
      const { gateway, makeClient } = setup();
      const client = makeClient();
      const sock = client as unknown as Socket;
      expect(await gateway.onSubscribe(body as never, sock)).toEqual({
        error: 'invalid',
      });
      expect(await gateway.onUnsubscribe(body as never, sock)).toEqual({
        error: 'invalid',
      });
      expect(client.join).not.toHaveBeenCalled();
      expect(client.leave).not.toHaveBeenCalled();
    });

    it('joins the room, emits the snapshot and acks', async () => {
      const { gateway, makeClient, redisClient } = setup();
      redisClient.getQuote.mockResolvedValue(tick);
      const client = makeClient();
      const ack = await gateway.onSubscribe(
        { symbol: 'AAPL' },
        client as unknown as Socket,
      );
      expect(ack).toEqual({ subscribed: 'AAPL' });
      expect(client.join).toHaveBeenCalledWith('ticks:AAPL');
      expect(client.emit).toHaveBeenCalledWith('tick', {
        symbol: 'AAPL',
        tick,
      });
    });

    it('skips the snapshot when absent and survives Redis errors', async () => {
      const { gateway, makeClient, redisClient } = setup();
      const client = makeClient();
      const sock = client as unknown as Socket;
      await gateway.onSubscribe({ symbol: 'AAPL' }, sock);
      redisClient.getQuote.mockRejectedValue(new Error('down'));
      expect(await gateway.onSubscribe({ symbol: 'MSFT' }, sock)).toEqual({
        subscribed: 'MSFT',
      });
      expect(client.emit).not.toHaveBeenCalled();
    });

    it('caps rooms per client but allows re-subscribing', async () => {
      const { gateway, makeClient } = setup();
      const client = makeClient();
      const sock = client as unknown as Socket;
      for (let i = 0; i < MAX_ROOMS_PER_CLIENT; i++) {
        await gateway.onSubscribe({ symbol: `S${i}` }, sock);
      }
      expect(await gateway.onSubscribe({ symbol: 'EXTRA' }, sock)).toEqual({
        error: 'limit',
      });
      expect(await gateway.onSubscribe({ symbol: 'S0' }, sock)).toEqual({
        subscribed: 'S0',
      });
    });

    it('acks unsubscribe', async () => {
      const { gateway, makeClient } = setup();
      const client = makeClient();
      expect(
        await gateway.onUnsubscribe(
          { symbol: 'AAPL' },
          client as unknown as Socket,
        ),
      ).toEqual({ unsubscribed: 'AAPL' });
      expect(client.leave).toHaveBeenCalledWith('ticks:AAPL');
    });
  });

  describe('tick broadcast', () => {
    it('validates and broadcasts to the symbol room', async () => {
      const { gateway, server, emit, sendTick } = setup();
      await gateway.onModuleInit();
      sendTick(tick, 'ticks:EUR/USD');
      expect(server.to).toHaveBeenCalledWith('ticks:EUR/USD');
      expect(emit).toHaveBeenCalledWith('tick', {
        symbol: 'EUR/USD',
        tick: { ...tick, symbol: 'EUR/USD' },
      });
    });

    it.each([
      [{ symbol: 'AAPL', price: 'x' }, 'ticks:AAPL'],
      ['garbage', 'ticks:AAPL'],
      [tick, 'other:AAPL'],
    ])('drops invalid tick %j', async (message, channel) => {
      const { gateway, emit, sendTick } = setup();
      await gateway.onModuleInit();
      sendTick(message, channel);
      expect(emit).not.toHaveBeenCalled();
    });
  });

  describe('keep-alive', () => {
    it('pings ingest while the room has members and stops when empty', async () => {
      vi.useFakeTimers();
      const { gateway, makeClient, ingest } = setup();
      const client = makeClient();
      const sock = client as unknown as Socket;
      await gateway.onSubscribe({ symbol: 'AAPL' }, sock);

      await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS);
      expect(ingest.subscribe).toHaveBeenCalledTimes(1);
      expect(ingest.subscribe).toHaveBeenCalledWith('AAPL');

      await gateway.onUnsubscribe({ symbol: 'AAPL' }, sock);
      await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS * 3);
      expect(ingest.subscribe).toHaveBeenCalledTimes(1);
    });

    it('keeps one timer per symbol and clears it on disconnect', async () => {
      vi.useFakeTimers();
      const { gateway, makeClient, ingest } = setup();
      const a = makeClient('a');
      const b = makeClient('b');
      await gateway.onSubscribe({ symbol: 'AAPL' }, a as unknown as Socket);
      await gateway.onSubscribe({ symbol: 'AAPL' }, b as unknown as Socket);
      await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS);
      expect(ingest.subscribe).toHaveBeenCalledTimes(1);

      // Socket.IO empties the rooms before handleDisconnect runs
      await a.leave('ticks:AAPL');
      gateway.handleDisconnect(a as unknown as Socket);
      await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS);
      expect(ingest.subscribe).toHaveBeenCalledTimes(2);

      await b.leave('ticks:AAPL');
      gateway.handleDisconnect(b as unknown as Socket);
      await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS * 3);
      expect(ingest.subscribe).toHaveBeenCalledTimes(2);
    });

    it('clears timers on module destroy', async () => {
      vi.useFakeTimers();
      const { gateway, makeClient, ingest } = setup();
      await gateway.onSubscribe(
        { symbol: 'AAPL' },
        makeClient() as unknown as Socket,
      );
      await gateway.onModuleDestroy();
      await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS * 3);
      expect(ingest.subscribe).not.toHaveBeenCalled();
    });
  });
});
