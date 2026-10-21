import {
  Inject,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  WebSocketGateway,
} from '@nestjs/websockets';
import type {
  ErrorMessage,
  RedisTick,
  ServerMessage,
  WsErrorCode,
} from '@repo/shared';
import {
  ClientMessageSchema,
  MAX_SYMBOLS_PER_MESSAGE,
} from '@repo/shared/ws-schema';
import type { Subscription } from 'rxjs';
import type { RawData, WebSocket } from 'ws';
import { APP_CONFIG, type AppConfig } from '../config.js';
import {
  type RedisStatus,
  TickSubscriberService,
} from '../redis/tick-subscriber.service.js';

/** Per-connection cap, same as the free-tier upstream symbol limit. */
export const MAX_SYMBOLS_PER_CONNECTION = MAX_SYMBOLS_PER_MESSAGE;
/** A client this far behind is dropped rather than buffered in memory. */
export const MAX_BUFFERED_BYTES = 1024 * 1024;

const OPEN = 1;
const CLOSE_TRY_AGAIN_LATER = 1013;

interface SymbolSub {
  /** Canonical casing from SYMBOLS; what the client sees. */
  canonical: string;
  live: Subscription;
  /** Ticks held back while a snapshot is in flight; null when streaming. */
  buffer: RedisTick[] | null;
  /** Bumped per snapshot load so a superseded load can bail out. */
  loadId: number;
}

interface ClientState {
  /** Keyed by lower-cased symbol. Pending subscribes are present too. */
  subs: Map<string, SymbolSub>;
}

@WebSocketGateway({ path: '/ws' })
export class TicksGateway
  implements
    OnGatewayConnection<WebSocket>,
    OnGatewayDisconnect<WebSocket>,
    OnModuleInit,
    OnModuleDestroy
{
  private readonly logger = new Logger(TicksGateway.name);
  private readonly clients = new Map<WebSocket, ClientState>();
  /** lower-cased -> canonical casing */
  private readonly allowList: ReadonlyMap<string, string>;
  private statusSub?: Subscription;

  constructor(
    private readonly ticks: TickSubscriberService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.allowList = new Map(config.symbols.map((s) => [s.toLowerCase(), s]));
  }

  onModuleInit(): void {
    let previous: RedisStatus | undefined;
    this.statusSub = this.ticks.status$.subscribe((status) => {
      try {
        // Pub/sub dropped any ticks published while Redis was down
        if (previous === 'down' && status === 'ready') {
          this.resnapshotAll();
        }
      } catch (error) {
        this.logger.error(`Re-snapshot failed: ${describe(error)}`);
      }
      previous = status;
    });
  }

  onModuleDestroy(): void {
    this.statusSub?.unsubscribe();
    // dispose() deletes from the map, so iterate a copy
    for (const client of Array.from(this.clients.keys())) {
      this.dispose(client);
    }
  }

  handleConnection(client: WebSocket): void {
    this.clients.set(client, { subs: new Map() });
    client.on('message', (data: RawData, isBinary?: boolean) => {
      this.handleFrame(client, data, isBinary).catch((error: unknown) => {
        this.logger.error(`Frame handling failed: ${describe(error)}`);
        this.sendError(client, 'internal', 'Internal error');
      });
    });
    client.on('error', (error: Error) => {
      this.logger.warn(`Client socket error: ${error.message}`);
    });
  }

  handleDisconnect(client: WebSocket): void {
    this.dispose(client);
  }

  private async handleFrame(
    client: WebSocket,
    data: RawData,
    isBinary?: boolean,
  ): Promise<void> {
    const state = this.clients.get(client);
    if (!state) {
      return;
    }
    const message = parseFrame(data, isBinary);
    if (!message) {
      this.sendError(client, 'invalid_message', 'Invalid message');
      return;
    }
    if (message.type === 'subscribe') {
      await this.subscribe(client, state, message.symbols);
    } else {
      this.unsubscribe(state, message.symbols);
    }
  }

  private async subscribe(
    client: WebSocket,
    state: ClientState,
    requested: string[],
  ): Promise<void> {
    const wanted = new Map<string, string>();
    for (const raw of requested) {
      const key = raw.toLowerCase();
      const canonical = this.allowList.get(key);
      if (!canonical) {
        this.sendError(client, 'unknown_symbol', `Unknown symbol: ${raw}`, raw);
        continue;
      }
      wanted.set(key, canonical);
    }

    const loads: Promise<string | null>[] = [];
    const subscribed: string[] = [];
    let rejected = 0;
    for (const [key, canonical] of wanted) {
      const existing = state.subs.get(key);
      if (existing) {
        subscribed.push(existing.canonical);
        continue;
      }
      if (state.subs.size >= MAX_SYMBOLS_PER_CONNECTION) {
        rejected++;
        continue;
      }
      loads.push(this.open(client, state, key, canonical));
    }
    if (rejected > 0) {
      this.sendError(
        client,
        'too_many_symbols',
        `At most ${MAX_SYMBOLS_PER_CONNECTION} symbols per connection`,
      );
    }
    for (const symbol of await Promise.all(loads)) {
      if (symbol) {
        subscribed.push(symbol);
      }
    }
    if (subscribed.length > 0 && this.clients.get(client) === state) {
      this.send(client, { type: 'subscribed', symbols: subscribed });
    }
  }

  /** Subscribes, then snapshot-then-live. Resolves the symbol, or null on failure. */
  private async open(
    client: WebSocket,
    state: ClientState,
    key: string,
    canonical: string,
  ): Promise<string | null> {
    const entry: SymbolSub = {
      canonical,
      buffer: [],
      loadId: 0,
      live: this.ticks.ticksFor(canonical).subscribe((tick) => {
        try {
          if (entry.buffer) {
            entry.buffer.push(tick);
          } else {
            this.send(client, { type: 'tick', symbol: canonical, tick });
          }
        } catch (error) {
          this.logger.error(`Tick delivery failed: ${describe(error)}`);
        }
      }),
    };
    state.subs.set(key, entry);
    try {
      await this.loadSnapshot(client, state, key, entry);
      return state.subs.get(key) === entry ? canonical : null;
    } catch (error) {
      if (state.subs.get(key) === entry) {
        entry.live.unsubscribe();
        state.subs.delete(key);
      }
      this.logger.warn(`Snapshot for ${canonical} failed: ${describe(error)}`);
      this.sendError(
        client,
        'internal',
        `Could not load ${canonical}`,
        canonical,
      );
      return null;
    }
  }

  /**
   * Sends a snapshot then flushes ticks buffered meanwhile. Ticks older than
   * the snapshot are dropped: the GET may have raced past them.
   */
  private async loadSnapshot(
    client: WebSocket,
    state: ClientState,
    key: string,
    entry: SymbolSub,
  ): Promise<void> {
    const loadId = ++entry.loadId;
    entry.buffer ??= [];
    const tick = await this.fetchQuote(entry.canonical);
    if (state.subs.get(key) !== entry || entry.loadId !== loadId) {
      return; // unsubscribed, disconnected or superseded by a newer load
    }
    this.send(client, { type: 'snapshot', symbol: entry.canonical, tick });
    const buffered = entry.buffer ?? [];
    entry.buffer = null;
    for (const live of buffered) {
      if (!tick || live.timestamp >= tick.timestamp) {
        this.send(client, {
          type: 'tick',
          symbol: entry.canonical,
          tick: live,
        });
      }
    }
  }

  private async fetchQuote(canonical: string): Promise<RedisTick | null> {
    const tick = await this.ticks.getQuote(canonical);
    const upper = canonical.toUpperCase();
    if (tick === null && upper !== canonical) {
      return this.ticks.getQuote(upper);
    }
    return tick;
  }

  private unsubscribe(state: ClientState, symbols: string[]): void {
    for (const raw of symbols) {
      const key = raw.toLowerCase();
      state.subs.get(key)?.live.unsubscribe();
      state.subs.delete(key);
    }
  }

  private resnapshotAll(): void {
    for (const [client, state] of this.clients) {
      for (const [key, entry] of state.subs) {
        this.loadSnapshot(client, state, key, entry).catch((error: unknown) => {
          this.logger.warn(
            `Re-snapshot for ${entry.canonical} failed: ${describe(error)}`,
          );
          if (state.subs.get(key) !== entry) {
            return;
          }
          // Keep streaming live; release whatever was held back
          const held = entry.buffer ?? [];
          entry.buffer = null;
          for (const tick of held) {
            this.send(client, { type: 'tick', symbol: entry.canonical, tick });
          }
          this.sendError(
            client,
            'internal',
            `Could not refresh ${entry.canonical}`,
            entry.canonical,
          );
        });
      }
    }
  }

  private dispose(client: WebSocket): void {
    const state = this.clients.get(client);
    if (!state) {
      return;
    }
    for (const entry of state.subs.values()) {
      entry.live.unsubscribe();
    }
    state.subs.clear();
    this.clients.delete(client);
  }

  private sendError(
    client: WebSocket,
    code: WsErrorCode,
    message: string,
    symbol?: string,
  ): void {
    const error: ErrorMessage = { type: 'error', code, message };
    if (symbol !== undefined) {
      error.symbol = symbol;
    }
    this.send(client, error);
  }

  private send(client: WebSocket, message: ServerMessage): void {
    if (client.readyState !== OPEN) {
      return;
    }
    if (client.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.logger.warn('Dropping slow client');
      this.dispose(client);
      client.close(CLOSE_TRY_AGAIN_LATER, 'Too slow');
      client.terminate();
      return;
    }
    try {
      client.send(JSON.stringify(message));
    } catch (error) {
      this.logger.warn(`Send failed: ${describe(error)}`);
    }
  }
}

function parseFrame(data: RawData, isBinary?: boolean) {
  if (isBinary) {
    return null;
  }
  try {
    const parsed = ClientMessageSchema.safeParse(JSON.parse(rawToString(data)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }
  return Buffer.isBuffer(data)
    ? data.toString('utf8')
    : Buffer.from(data).toString('utf8');
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
