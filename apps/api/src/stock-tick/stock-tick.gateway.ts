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
  symbolFromChannel,
  tickChannel,
  TICK_CHANNEL_PATTERN,
  type RedisTick,
} from '@repo/shared';
import { RedisSubscriberService } from '../redis/redis-subscriber.service.js';

interface SymbolPayload {
  symbol: string;
}

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

  constructor(private readonly redisSubscriber: RedisSubscriberService) {}

  // One Redis pattern subscription for the whole gateway. Fan-out to clients
  // is done by Socket.IO rooms, so there is no per-client Redis bookkeeping.
  async onModuleInit() {
    this.unsubscribeRedis = await this.redisSubscriber.psubscribe<RedisTick>(
      TICK_CHANNEL_PATTERN,
      (tick, channel) => {
        const symbol = symbolFromChannel(channel);
        if (!symbol) return;
        // TODO: validate `tick` (see redis/parse-tick.ts) before broadcasting
        this.server.to(tickChannel(symbol)).emit('tick', { symbol, tick });
      },
    );
  }

  async onModuleDestroy() {
    await this.unsubscribeRedis?.();
  }

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
  }

  // Socket.IO removes the client from all rooms on disconnect by itself.
  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  // Client: socket.emit('subscribe', { symbol: 'AAPL' }, (ack) => ...)
  @SubscribeMessage('subscribe')
  async onSubscribe(
    @MessageBody() body: SymbolPayload,
    @ConnectedSocket() client: Socket,
  ) {
    // TODO: validate body, check the symbol against the SYMBOLS allow-list,
    //       cap the number of symbols per client
    await client.join(tickChannel(body.symbol));
    this.logger.log(`${client.id} subscribed to ${body.symbol}`);

    // TODO: send the latest snapshot (GET quote:{symbol}); needs a regular
    //       (non-subscriber) Redis connection
    return { subscribed: body.symbol };
  }

  // Client: socket.emit('unsubscribe', { symbol: 'AAPL' })
  @SubscribeMessage('unsubscribe')
  async onUnsubscribe(
    @MessageBody() body: SymbolPayload,
    @ConnectedSocket() client: Socket,
  ) {
    await client.leave(tickChannel(body.symbol));
    this.logger.log(`${client.id} unsubscribed from ${body.symbol}`);
    return { unsubscribed: body.symbol };
  }
}
