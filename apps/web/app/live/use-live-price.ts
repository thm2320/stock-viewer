"use client";

import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  SubscribeAck,
  TickEvent,
} from "@repo/shared";
import {
  requestSubscription,
  type SubscribeFailureCode,
} from "../../lib/subscriptions";
import { applyTick, isValidTick, type LiveState } from "../../lib/tick-state";

export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";

/** Shape of the gateway's `subscribe` ack; shared only types the success case. */
type SubscribeAckResult = SubscribeAck | { error: SubscribeFailureCode };

type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** No tick for this long while connected counts as stale. */
export const STALE_MS = 30_000;

export function useLivePrice(apiUrl: string, symbol: string) {
  const socketRef = useRef<AppSocket | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [state, setState] = useState<LiveState | null>(null);
  const [subscribeError, setSubscribeError] =
    useState<SubscribeFailureCode | null>(null);
  const connectedOnce = useRef(false);
  const [now, setNow] = useState(() => Date.now());

  // Connection. Created and closed inside the effect so StrictMode's
  // mount/cleanup/mount leaves exactly one open socket.
  useEffect(() => {
    const socket: AppSocket = io(apiUrl, { transports: ["websocket"] });
    socketRef.current = socket;
    connectedOnce.current = false;

    socket.on("connect", () => setStatus("connected"));
    socket.on("disconnect", (reason) => {
      if (reason === "io server disconnect") {
        // Socket.IO does not retry after a server-initiated disconnect
        setStatus("connecting");
        socket.connect();
      } else if (reason === "io client disconnect") {
        setStatus("disconnected");
      } else {
        setStatus("reconnecting");
      }
    });
    socket.on("connect_error", () => setStatus("reconnecting"));
    socket.io.on("reconnect_attempt", () => setStatus("reconnecting"));

    return () => {
      socket.removeAllListeners();
      socket.io.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [apiUrl]);

  // Subscription. Server rooms are lost on reconnect, so subscribe again on
  // every `connect`, not only once.
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket) return;

    let cancelled = false;
    setSubscribeError(null);

    const emitSubscribe = () =>
      socket.emit("subscribe", { symbol }, (ack: SubscribeAckResult) => {
        if (cancelled) return;
        setSubscribeError("error" in ack ? ack.error : null);
      });
    const onConnect = () => {
      if (!connectedOnce.current) {
        connectedOnce.current = true;
        emitSubscribe();
        return;
      }
      // Reconnect: ingest may have swept an idle dynamic symbol while we
      // were away, so make sure it is being ingested before rejoining.
      void requestSubscription(apiUrl, symbol).then((result) => {
        if (cancelled) return;
        if (!result.ok) setSubscribeError(result.error);
        emitSubscribe();
      });
    };
    const onTick = (event: TickEvent) => {
      if (event.symbol !== symbol || !isValidTick(event.tick)) return;
      setState((prev) => applyTick(prev, symbol, event.tick, Date.now()));
    };

    socket.on("connect", onConnect);
    socket.on("tick", onTick);
    if (socket.connected) {
      connectedOnce.current = true;
      emitSubscribe();
    }

    return () => {
      cancelled = true;
      socket.off("connect", onConnect);
      socket.off("tick", onTick);
      if (socket.connected) socket.emit("unsubscribe", { symbol });
    };
  }, [apiUrl, symbol]);

  // Clock for the stale check
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Derived so a symbol switch shows "waiting" without resetting state
  const live = state?.symbol === symbol ? state : null;
  const isStale =
    status === "connected" && live !== null && now - live.receivedAt > STALE_MS;

  return { status, live, isStale, subscribeError };
}
