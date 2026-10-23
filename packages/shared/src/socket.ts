import type { RedisTick } from "./tick.js";

/** Payload of `subscribe` / `unsubscribe`: one symbol per message. */
export interface SymbolPayload {
  symbol: string;
}

/** Server -> client `tick`: emitted to the room of `symbol` for each Redis tick. */
export interface TickEvent {
  symbol: string;
  tick: RedisTick;
}

export interface SubscribeAck {
  subscribed: string;
}
export interface UnsubscribeAck {
  unsubscribed: string;
}

/** Events the server emits; use as `ServerToClientEvents` in socket.io generics. */
export interface ServerToClientEvents {
  tick: (event: TickEvent) => void;
}

/** Events the server handles; use as `ClientToServerEvents` in socket.io generics. */
export interface ClientToServerEvents {
  subscribe: (payload: SymbolPayload, ack?: (r: SubscribeAck) => void) => void;
  unsubscribe: (
    payload: SymbolPayload,
    ack?: (r: UnsubscribeAck) => void,
  ) => void;
}
