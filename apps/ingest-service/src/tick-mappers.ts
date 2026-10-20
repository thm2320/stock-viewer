import type {
  GetQuote200Response,
  PriceEvent,
} from "@twelvedata/twelvedata-node";
import type { RedisTick } from "@repo/shared";
import type { NormalizedTick, RawTick } from "./types.ts";

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

export function toRedisTick(tick: RawTick | NormalizedTick): RedisTick {
  if ("price" in tick) {
    const { expiresAt: _expiresAt, ...rest } = tick;
    return rest;
  }

  const redisTick: RedisTick = {
    symbol: tick.symbol,
    timestamp: tick.timestamp,
    // Quotes carry no live price; the close is the latest price
    price: tick.close as number,
    dayVolume: tick.volume,
    currency: tick.currency,
    exchange: tick.exchange,
    ingestedAt: tick.ingestedAt,
  };

  // Drop undefined fields, same as the other mappers
  return Object.fromEntries(
    Object.entries(redisTick).filter(([, value]) => value !== undefined),
  ) as unknown as RedisTick;
}
