export interface FiftyTwoWeek {
  low: string;
  high: string;
  lowChange: string;
  highChange: string;
  lowChangePercent: string;
  highChangePercent: string;
  range: string; // '243.419998 - 348.149994'
}

export interface TweleveDataQuote {
  symbol: string;
  name: string;
  exchange: string;
  micCode: string;
  currency: string;
  datetime: string;      // 'YYYY-MM-DD' for daily quotes
  timestamp: number;     // Unix seconds
  lastQuoteAt: number;   // Unix seconds

  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  previousClose: string;
  change: string;
  percentChange: string;
  averageVolume: string;

  isMarketOpen: boolean;
  fiftyTwoWeek: FiftyTwoWeek;

  rolling1dChange?: string;
  rolling7dChange?: string;
  rollingChange?: string;

  extendedChange?: string;
  extendedPercentChange?: string;
  extendedPrice?: string;
  extendedTimestamp?: number;
}

interface NormalizedTick {
    
}