"use client";

import { useEffect, useState, type FormEvent } from "react";
import { isValidSymbol } from "@repo/shared";
import { formatDelta, formatPrice, formatTime } from "../../lib/format";
import { addRecentSymbol, loadRecentSymbols } from "../../lib/recent-symbols";
import {
  errorMessage,
  requestSubscription,
  type SubscribeFailureCode,
} from "../../lib/subscriptions";
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
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<SubscribeFailureCode | null>(null);
  const [recents, setRecents] = useState<string[]>([]);
  const { status, live, isStale, subscribeError } = useLivePrice(
    apiUrl,
    symbol,
  );

  // localStorage is unavailable during SSR, so load after mount
  useEffect(() => setRecents(loadRecentSymbols()), []);

  const chips = dedupeSymbols([...symbols, ...recents]);
  const shownError = error ?? subscribeError;

  async function subscribe(raw: string) {
    if (pending) return;
    const next = raw.replace(/\s+/g, "");
    if (!isValidSymbol(next)) {
      setError("invalid");
      return;
    }
    setPending(true);
    setError(null);
    const result = await requestSubscription(apiUrl, next);
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSymbol(next);
    setRecents(addRecentSymbol(next));
    setInput("");
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void subscribe(input);
  }

  return (
    <main className={styles.main}>
      <h1>Live prices</h1>

      <div className={styles.controls}>
        <form className={styles.form} onSubmit={onSubmit}>
          <label>
            Symbol{" "}
            <input
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setError(null);
              }}
              placeholder="AAPL, EUR/USD"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={error !== null}
            />
          </label>
          <button type="submit" disabled={pending}>
            {pending ? "Subscribing..." : "Subscribe"}
          </button>
        </form>
        <p role="status" className={`${styles.status} ${styles[status]}`}>
          <span className={styles.dot} aria-hidden="true" />
          {STATUS_LABEL[status]}
        </p>
      </div>

      {shownError && (
        <p role="alert" className={styles.error}>
          {errorMessage(shownError)}
        </p>
      )}

      <div className={styles.chips}>
        {chips.map((s) => (
          <button
            key={s}
            type="button"
            className={styles.chip}
            aria-pressed={s.toLowerCase() === symbol.toLowerCase()}
            disabled={pending}
            onClick={() => void subscribe(s)}
          >
            {s}
          </button>
        ))}
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

function dedupeSymbols(list: string[]): string[] {
  const seen = new Set<string>();
  return list.filter((s) => {
    const key = s.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
