export interface HistoryPoint {
  /** Unix seconds */
  time: number;
  price: number;
}

export interface HistoryQuery {
  symbol: string;
  /** Unix seconds, inclusive */
  from?: number;
  /** Unix seconds, inclusive */
  to?: number;
  limit?: number;
}

export interface HistoryResponse {
  symbol: string;
  from: number;
  to: number;
  /** Ascending by time, unique on time */
  points: HistoryPoint[];
}
