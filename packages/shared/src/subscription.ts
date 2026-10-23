/** Why a subscription request was refused. */
export const SUBSCRIPTION_ERRORS = [
  "invalid",
  "unsupported",
  "capacity",
  "unavailable",
] as const;

export type SubscriptionErrorCode = (typeof SUBSCRIPTION_ERRORS)[number];

/** Body of `POST /subscriptions` (API) and of ingest's `POST /subscriptions`. */
export interface SubscribeRequest {
  symbol: string;
}

export interface SubscribeResponse {
  symbol: string;
}

export interface SubscribeError {
  error: SubscriptionErrorCode;
}
