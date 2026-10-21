import { symbolFromChannel, type RedisTick } from '@repo/shared';

export interface ParsedTick {
  symbol: string;
  tick: RedisTick;
}

export type ParseFailure = 'bad_channel' | 'bad_json' | 'bad_shape';

export type ParseResult =
  { ok: true; value: ParsedTick } | { ok: false; reason: ParseFailure };

const MAX_LOGGED_PAYLOAD = 200;

/**
 * Parses a message from a ticks:{symbol} channel. The channel is the routing
 * key: the symbol is sliced from it and overwrites tick.symbol.
 */
export function parseTickMessage(
  channel: string,
  payload: string,
): ParseResult {
  const symbol = symbolFromChannel(channel);
  if (!symbol) {
    return { ok: false, reason: 'bad_channel' };
  }
  const parsed = parseJson(payload);
  if (!parsed.ok) {
    return parsed;
  }
  const tick = toRedisTick(parsed.value);
  if (!tick) {
    return { ok: false, reason: 'bad_shape' };
  }
  return { ok: true, value: { symbol, tick: { ...tick, symbol } } };
}

/** Parses a quote:{symbol} value (GET snapshot); undefined if unusable. */
export function parseRedisTick(payload: string): RedisTick | undefined {
  const parsed = parseJson(payload);
  return parsed.ok ? toRedisTick(parsed.value) : undefined;
}

/** Bounds a payload for logging. */
export function truncatePayload(payload: string): string {
  return payload.length > MAX_LOGGED_PAYLOAD
    ? `${payload.slice(0, MAX_LOGGED_PAYLOAD)}…`
    : payload;
}

function parseJson(
  payload: string,
): { ok: true; value: unknown } | { ok: false; reason: 'bad_json' } {
  try {
    return { ok: true, value: JSON.parse(payload) };
  } catch {
    return { ok: false, reason: 'bad_json' };
  }
}

/** Checks the fields ingest always writes; optional fields pass through. */
function toRedisTick(value: unknown): RedisTick | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const { symbol, price, timestamp, ingestedAt } = value as Record<
    string,
    unknown
  >;
  if (
    typeof symbol !== 'string' ||
    !Number.isFinite(price) ||
    !Number.isFinite(timestamp) ||
    !Number.isFinite(ingestedAt)
  ) {
    return undefined;
  }
  return value as RedisTick;
}
