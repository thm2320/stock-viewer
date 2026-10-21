export interface AppConfig {
  redisUrl: string;
  /** Canonical casing as written in SYMBOLS; the gateway allow-list. */
  symbols: string[];
  port: number;
}

export class ConfigError extends Error {}

export const APP_CONFIG = Symbol('APP_CONFIG');

const DEFAULT_PORT = 3002;
const DEFAULT_SYMBOLS = 'AAPL';
// Allows EUR/USD, RY:TSX, BRK.B; excludes Redis glob characters
const SYMBOL_PATTERN = /^[A-Za-z0-9._:/-]+$/;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    redisUrl: parseRedisUrl(env.REDIS_URL),
    symbols: parseSymbols(env.SYMBOLS),
    port: parsePort(env.PORT),
  };
}

function parseRedisUrl(raw: string | undefined): string {
  if (!raw) {
    throw new ConfigError('Missing required env var REDIS_URL');
  }
  try {
    const { protocol } = new URL(raw);
    if (protocol !== 'redis:' && protocol !== 'rediss:') {
      throw new Error();
    }
  } catch {
    // Never echo the value: it may contain a password
    throw new ConfigError(
      'Invalid REDIS_URL: expected a redis:// or rediss:// URL.',
    );
  }
  return raw;
}

/** Same comma-separated format as ingest's SYMBOLS (default AAPL). */
function parseSymbols(raw: string | undefined): string[] {
  const seen = new Set<string>();
  const symbols: string[] = [];
  for (const entry of (raw ?? DEFAULT_SYMBOLS).split(',')) {
    const symbol = entry.trim();
    if (!symbol) {
      continue;
    }
    if (!SYMBOL_PATTERN.test(symbol)) {
      throw new ConfigError(`Invalid symbol in SYMBOLS: "${symbol}"`);
    }
    const key = symbol.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    symbols.push(symbol);
  }
  if (symbols.length === 0) {
    throw new ConfigError('SYMBOLS must contain at least one symbol');
  }
  return symbols;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return DEFAULT_PORT;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`Invalid PORT "${raw}": expected 1-65535.`);
  }
  return port;
}
