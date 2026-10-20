export interface NormalizedTick {
  symbol: string;
  timestamp: number; // Unix seconds, bar time
  name?: string;
  exchange?: string;
  currency?: string;
  datetime?: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  previousClose?: number;
  change?: number;
  percentChange?: number;
  volume?: number;
  averageVolume?: number;
  isMarketOpen?: boolean;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  ingestedAt: number; // Unix ms
}

// One WebSocket price event; price only, unlike the quote-shaped NormalizedTick
export interface RawTick {
  symbol: string;
  timestamp: number; // Unix seconds, tick time
  price: number;
  bid?: number;
  ask?: number;
  dayVolume?: number;
  currency?: string;
  exchange?: string;
  micCode?: string;
  type?: string;
  ingestedAt: number; // Unix ms
  expiresAt: number; // Unix seconds, DynamoDB TTL
}

// Tick shape published to Redis: RawTick without the DynamoDB-only TTL
export type RedisTick = Omit<RawTick, "expiresAt">;
