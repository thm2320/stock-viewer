export const QUOTE_KEY_PREFIX = "quote:";
export const TICK_CHANNEL_PREFIX = "ticks:";
/** Glob for PSUBSCRIBE */
export const TICK_CHANNEL_PATTERN = `${TICK_CHANNEL_PREFIX}*`;

export function quoteKey(symbol: string): string {
  return `${QUOTE_KEY_PREFIX}${symbol}`;
}

export function tickChannel(symbol: string): string {
  return `${TICK_CHANNEL_PREFIX}${symbol}`;
}

/** Inverse of tickChannel; slices the prefix, never splits on ":" (symbols may contain ":" or "/"). */
export function symbolFromChannel(channel: string): string | undefined {
  return channel.startsWith(TICK_CHANNEL_PREFIX)
    ? channel.slice(TICK_CHANNEL_PREFIX.length)
    : undefined;
}

/** Redis set of dynamically subscribed symbols; ingest reloads it on boot. */
export const DYNAMIC_SYMBOLS_KEY = "dynamic:symbols";
