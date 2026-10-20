import type { RedisTick } from "./tick.js";

// Client -> Server
export interface SubscribeMessage {
  type: "subscribe";
  symbols: string[];
}
export interface UnsubscribeMessage {
  type: "unsubscribe";
  symbols: string[];
}
export type ClientMessage = SubscribeMessage | UnsubscribeMessage;

// Server -> Client
/** Latest known quote for a symbol, sent right after a subscribe (from Redis GET quote:{symbol}). */
export interface SnapshotMessage {
  type: "snapshot";
  symbol: string;
  /** null = nothing cached yet */
  tick: RedisTick | null;
}
export interface TickMessage {
  type: "tick";
  symbol: string;
  tick: RedisTick;
}
export interface SubscribedMessage {
  type: "subscribed";
  symbols: string[];
}
export type WsErrorCode =
  | "invalid_message"
  | "invalid_symbol"
  | "unknown_symbol"
  | "too_many_symbols"
  | "internal";
export interface ErrorMessage {
  type: "error";
  code: WsErrorCode;
  message: string;
  symbol?: string;
}
export type ServerMessage =
  | SnapshotMessage
  | TickMessage
  | SubscribedMessage
  | ErrorMessage;
