"use client";

import { useState } from "react";
import { formatDelta, formatPrice, formatTime } from "../../lib/format";
import type { Direction } from "../../lib/tick-state";
import { useLivePrice, type ConnectionStatus } from "./use-live-price";
import styles from "./live-prices.module.css";

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connecting: "Connecting...",
  connected: "Connected",
  reconnecting: "Reconnecting...",
  disconnected: "Disconnected",
};

const ARROW: Record<Direction, string> = { up: "▲", down: "▼", flat: "" };

export function LivePrices({
  apiUrl,
  symbols,
}: {
  apiUrl: string;
  symbols: string[];
}) {
  const [symbol, setSymbol] = useState(symbols[0] ?? "");
  const { status, live, isStale } = useLivePrice(apiUrl, symbol);

  return (
    <main className={styles.main}>
      <h1>Live prices</h1>

      <div className={styles.controls}>
        <label>
          Symbol{" "}
          <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
            {symbols.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <p role="status" className={`${styles.status} ${styles[status]}`}>
          <span className={styles.dot} aria-hidden="true" />
          {STATUS_LABEL[status]}
        </p>
      </div>

      <section className={styles.card} aria-label={`${symbol} price`}>
        {live ? (
          <>
            {/* key changes with each price change, restarting the flash animation */}
            <p
              key={live.seq}
              className={`${styles.price} ${styles[live.direction]} ${live.seq > 0 ? styles.flash : ""}`}
            >
              {formatPrice(live.tick.price, live.tick.currency)}
              <span className={styles.arrow} aria-hidden="true">
                {ARROW[live.direction]}
              </span>
            </p>
            {live.delta !== 0 && (
              <p className={`${styles.delta} ${styles[live.direction]}`}>
                {formatDelta(live.delta)}
              </p>
            )}
            <p className={styles.meta}>
              Updated {formatTime(live.tick.timestamp)}
              {isStale && " · no recent ticks"}
            </p>
          </>
        ) : (
          <p className={styles.meta}>
            {status === "connected"
              ? "Waiting for first tick..."
              : STATUS_LABEL[status]}
          </p>
        )}
      </section>
    </main>
  );
}
