import type {
  GetQuote200Response,
  PriceEvent,
} from "@twelvedata/twelvedata-node";

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

// TwelveData returns numbers as strings; undefined or NaN becomes undefined
function toNumber(value: string | number | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function normalize(
  quote: GetQuote200Response,
  ingestedAt: number,
): NormalizedTick {
  const tick: NormalizedTick = {
    symbol: quote.symbol,
    timestamp: quote.timestamp,
    name: quote.name,
    exchange: quote.exchange,
    currency: quote.currency,
    datetime: quote.datetime,
    open: toNumber(quote.open),
    high: toNumber(quote.high),
    low: toNumber(quote.low),
    close: toNumber(quote.close),
    previousClose: toNumber(quote.previousClose),
    change: toNumber(quote.change),
    percentChange: toNumber(quote.percentChange),
    volume: toNumber(quote.volume),
    averageVolume: toNumber(quote.averageVolume),
    isMarketOpen: quote.isMarketOpen,
    fiftyTwoWeekHigh: toNumber(quote.fiftyTwoWeek?.high),
    fiftyTwoWeekLow: toNumber(quote.fiftyTwoWeek?.low),
    ingestedAt,
  };

  // Drop undefined fields so they are never written
  return Object.fromEntries(
    Object.entries(tick).filter(([, value]) => value !== undefined),
  ) as unknown as NormalizedTick;
}

// Raw ticks expire after 7 days (DynamoDB TTL)
const TICK_RETENTION_SECONDS = 7 * 24 * 60 * 60;

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

export function toRawTick(event: PriceEvent, ingestedAt: number): RawTick {
  if (!Number.isFinite(event.price) || !Number.isFinite(event.timestamp)) {
    throw new Error(
      `Invalid price event for ${event.symbol}: price=${event.price}, timestamp=${event.timestamp}`,
    );
  }

  const tick: RawTick = {
    symbol: event.symbol,
    timestamp: event.timestamp,
    price: event.price,
    bid: event.bid,
    ask: event.ask,
    dayVolume: event.day_volume,
    currency: event.currency,
    exchange: event.exchange,
    micCode: event.mic_code,
    type: event.type,
    ingestedAt,
    expiresAt: Math.floor(ingestedAt / 1000) + TICK_RETENTION_SECONDS,
  };

  // Drop undefined fields so they are never written
  return Object.fromEntries(
    Object.entries(tick).filter(([, value]) => value !== undefined),
  ) as unknown as RawTick;
}
