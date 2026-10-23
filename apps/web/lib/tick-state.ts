import type { RedisTick } from "@repo/shared";

export type Direction = "up" | "down" | "flat";

export interface LiveState {
  symbol: string;
  tick: RedisTick;
  /** Direction of the last price change; kept across equal-price ticks. */
  direction: Direction;
  /** Price change versus the previous tick of the same symbol. */
  delta: number;
  /** Bumped on every price change; used as a React key to restart the flash. */
  seq: number;
  /** Date.now() when the tick arrived in the browser. */
  receivedAt: number;
}

export function isValidTick(tick: unknown): tick is RedisTick {
  return (
    typeof tick === "object" &&
    tick !== null &&
    Number.isFinite((tick as RedisTick).price)
  );
}

export function applyTick(
  prev: LiveState | null,
  symbol: string,
  tick: RedisTick,
  now: number,
): LiveState {
  const last = prev?.symbol === symbol ? prev : null;
  const delta = last ? tick.price - last.tick.price : 0;
  const changed = delta !== 0;
  return {
    symbol,
    tick,
    direction: changed ? (delta > 0 ? "up" : "down") : (last?.direction ?? "flat"),
    delta,
    seq: (last?.seq ?? 0) + (changed ? 1 : 0),
    receivedAt: now,
  };
}
