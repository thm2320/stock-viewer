import type {
  SubscribeError,
  SubscribeResponse,
  SubscriptionErrorCode,
} from "@repo/shared";

/** API codes plus the ones only the web app can produce. */
export type SubscribeFailureCode =
  | SubscriptionErrorCode
  | "rate_limited"
  | "limit";

export type SubscribeResult =
  | { ok: true; symbol: string }
  | { ok: false; error: SubscribeFailureCode };

const REQUEST_TIMEOUT_MS = 8000;

const MESSAGES: Record<SubscribeFailureCode, string> = {
  invalid: "That does not look like a valid symbol.",
  unsupported: "TwelveData does not support that symbol.",
  capacity: "No free slot right now. Try again later.",
  unavailable: "Cannot reach the data service.",
  rate_limited: "Too many requests. Wait a moment.",
  limit: "Too many symbols open. Remove one first.",
};

export function errorMessage(code: SubscribeFailureCode): string {
  return MESSAGES[code];
}

const API_CODES: readonly string[] = [
  "invalid",
  "unsupported",
  "capacity",
  "unavailable",
];

/** Asks the API to make sure `symbol` is being ingested. Never throws. */
export async function requestSubscription(
  apiUrl: string,
  symbol: string,
): Promise<SubscribeResult> {
  try {
    const res = await fetch(`${apiUrl}/subscriptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 429) return { ok: false, error: "rate_limited" };
    if (res.status >= 500) return { ok: false, error: "unavailable" };

    const body = (await res.json()) as Partial<
      SubscribeResponse & SubscribeError
    >;
    if (res.ok && typeof body.symbol === "string") {
      return { ok: true, symbol: body.symbol };
    }
    if (typeof body.error === "string" && API_CODES.includes(body.error)) {
      return { ok: false, error: body.error };
    }
    return { ok: false, error: "unavailable" };
  } catch {
    // network failure, timeout or unparsable body
    return { ok: false, error: "unavailable" };
  }
}
