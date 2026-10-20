import type { RedisTick } from "@repo/shared";

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
export interface RawTick extends RedisTick {
  expiresAt: number; // Unix seconds, DynamoDB TTL
}
