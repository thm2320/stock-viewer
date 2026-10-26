export interface AppConfig {
  redisUrl: string;
  /** Base URL of ingest's control server (POST /subscriptions). */
  ingestUrl: string;
  ingestToken: string;
  port: number;
}

export class ConfigError extends Error {}

export const APP_CONFIG = Symbol('APP_CONFIG');

const DEFAULT_PORT = 3002;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    redisUrl: parseRedisUrl(env.REDIS_URL),
    ingestUrl: parseIngestUrl(env.INGEST_URL),
    ingestToken: parseIngestToken(env.INGEST_TOKEN),
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

function parseIngestUrl(raw: string | undefined): string {
  if (!raw) {
    throw new ConfigError('Missing required env var INGEST_URL');
  }
  try {
    const { protocol } = new URL(raw);
    if (protocol !== 'http:' && protocol !== 'https:') {
      throw new Error();
    }
  } catch {
    throw new ConfigError('Invalid INGEST_URL: expected an http(s):// URL.');
  }
  return raw;
}

function parseIngestToken(raw: string | undefined): string {
  if (!raw?.trim()) {
    throw new ConfigError('Missing required env var INGEST_TOKEN');
  }
  return raw;
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
