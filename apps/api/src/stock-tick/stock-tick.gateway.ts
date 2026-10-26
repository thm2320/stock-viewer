import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import {
  isValidSymbol,
  tickChannel,
  TICK_CHANNEL_PATTERN,
  TICK_CHANNEL_PREFIX,
  type SubscribeAck,
  type SubscriptionErrorCode,
  type UnsubscribeAck,
} from '@repo/shared';
import { parseTickMessage, truncatePayload } from '../redis/parse-tick.js';
import { RedisClientService } from '../redis/redis-client.service.js';
import { RedisSubscriberService } from '../redis/redis-subscriber.service.js';
import { IngestClient } from '../subscriptions/ingest.client.js';

interface SymbolPayload {
  symbol: unknown;
}

export type GatewayError = { error: SubscriptionErrorCode | 'limit' };

export const MAX_ROOMS_PER_CLIENT = 20;
// Must stay well under ingest's IDLE_TTL_MS (default 10 min)
export const KEEP_ALIVE_MS = 3 * 60_000;

// Shares the HTTP port. Tighten `origin` before deploying.
@WebSocketGateway({ cors: { origin: '*' } })
export class StockTickGateway
  implements
    OnModuleInit,
    OnModuleDestroy,
    OnGatewayConnection,
    OnGatewayDisconnect
{
  private readonly logger = new Logger(StockTickGateway.name);

  @WebSocketServer()
  private readonly server!: Server;

  private unsubscribeRedis?: () => Promise<void>;

  // One timer per symbol with room members; re-subscribes it on ingest so the
  // idle sweep does not drop a symbol someone is still watching.
  private readonly keepAlives = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly redisSubscriber: RedisSubscriberService,
    private readonly redisClient: RedisClientService,
    private readonly ingest: IngestClient,
  ) {}

  // One Redis pattern subscription for the whole gateway. Fan-out to clients
  // is done by Socket.IO rooms, so there is no per-client Redis bookkeeping.
  async onModuleInit() {
    this.unsubscribeRedis = await this.redisSubscriber.psubscribe<unknown>(
      TICK_CHANNEL_PATTERN,
      (message, channel) => {
        // The subscriber parses JSON; re-serialize so parse-tick owns validation
        const raw =
          typeof message === 'string' ? message : JSON.stringify(message);
        const parsed = parseTickMessage(channel, raw);
        if (!parsed.ok) {
          this.logger.warn(
            `Dropping tick on ${channel} (${parsed.reason}): ${truncatePayload(raw)}`,
          );
          return;
        }
        const { symbol, tick } = parsed.value;
        this.server.to(tickChannel(symbol)).emit('tick', { symbol, tick });
      },
    );
  }

  async onModuleDestroy() {
    for (const timer of this.keepAlives.values()) {
      clearInterval(timer);
    }
    this.keepAlives.clear();
    await this.unsubscribeRedis?.();
  }

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
  }

  // Socket.IO removes the client from all rooms on disconnect by itself.
  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
    this.reapKeepAlives();
  }

  // Client: socket.emit('subscribe', { symbol: 'AAPL' }, (ack) => ...)
  @SubscribeMessage('subscribe')
  async onSubscribe(
    @MessageBody() body: SymbolPayload,
    @ConnectedSocket() client: Socket,
  ): Promise<SubscribeAck | GatewayError> {
    const symbol = body?.symbol;
    if (!isValidSymbol(symbol)) {
      return { error: 'invalid' };
    }
    const room = tickChannel(symbol);
    if (
      !client.rooms.has(room) &&
      this.roomCount(client) >= MAX_ROOMS_PER_CLIENT
    ) {
      return { error: 'limit' };
    }
    await client.join(room);
    this.logger.log(`${client.id} subscribed to ${symbol}`);
    this.ensureKeepAlive(symbol);

    // Snapshot so the client has a price before the next tick arrives
    try {
      const tick = await this.redisClient.getQuote(symbol);
      if (tick) {
        client.emit('tick', { symbol, tick });
      }
    } catch (err) {
      this.logger.warn(
        `Snapshot for ${symbol} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { subscribed: symbol };
  }

  // Client: socket.emit('unsubscribe', { symbol: 'AAPL' })
  @SubscribeMessage('unsubscribe')
  async onUnsubscribe(
    @MessageBody() body: SymbolPayload,
    @ConnectedSocket() client: Socket,
  ): Promise<UnsubscribeAck | GatewayError> {
    const symbol = body?.symbol;
    if (!isValidSymbol(symbol)) {
      return { error: 'invalid' };
    }
    await client.leave(tickChannel(symbol));
    this.logger.log(`${client.id} unsubscribed from ${symbol}`);
    this.reapKeepAlives();
    return { unsubscribed: symbol };
  }

  private roomCount(client: Socket): number {
    let count = 0;
    for (const room of client.rooms) {
      if (room.startsWith(TICK_CHANNEL_PREFIX)) {
        count++;
      }
    }
    return count;
  }

  private ensureKeepAlive(symbol: string) {
    if (this.keepAlives.has(symbol)) {
      return;
    }
    const timer = setInterval(() => {
      void this.ingest.subscribe(symbol).then((result) => {
        if (!result.ok) {
          this.logger.warn(`Keep-alive for ${symbol} failed: ${result.error}`);
        }
      });
    }, KEEP_ALIVE_MS);
    timer.unref();
    this.keepAlives.set(symbol, timer);
  }

  /** Clears timers of symbols whose room has emptied. */
  private reapKeepAlives() {
    const rooms = this.server.sockets.adapter.rooms;
    for (const [symbol, timer] of this.keepAlives) {
      if (rooms.get(tickChannel(symbol))?.size) {
        continue;
      }
      clearInterval(timer);
      this.keepAlives.delete(symbol);
    }
  }
}
