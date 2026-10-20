/** Live price tick published to Redis (SET quote:{symbol}, PUBLISH ticks:{symbol}). */
export interface RedisTick {
  symbol: string;
  /** Unix seconds, tick time */
  timestamp: number;
  price: number;
  bid?: number;
  ask?: number;
  dayVolume?: number;
  currency?: string;
  exchange?: string;
  micCode?: string;
  type?: string;
  /** Unix ms, when ingest received it */
  ingestedAt: number;
}
