const formatters = new Map<string, Intl.NumberFormat>();

function numberFormat(currency: string | undefined): Intl.NumberFormat {
  const key = currency ?? "";
  let formatter = formatters.get(key);
  if (!formatter) {
    try {
      formatter = currency
        ? new Intl.NumberFormat(undefined, {
            style: "currency",
            currency,
            minimumFractionDigits: 2,
            maximumFractionDigits: 4,
          })
        : undefined;
    } catch {
      formatter = undefined; // not a valid ISO 4217 code
    }
    // FX pairs such as EUR/USD need more decimals than currency amounts
    formatter ??= new Intl.NumberFormat(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    });
    formatters.set(key, formatter);
  }
  return formatter;
}

export function formatPrice(price: number, currency?: string): string {
  return numberFormat(currency).format(price);
}

/** Signed change, e.g. "+0.12" / "-0.0003". */
export function formatDelta(delta: number): string {
  return new Intl.NumberFormat(undefined, {
    signDisplay: "exceptZero",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(delta);
}

/** @param timestampSec Unix seconds */
export function formatTime(timestampSec: number): string {
  return new Intl.DateTimeFormat(undefined, { timeStyle: "medium" }).format(
    timestampSec * 1000,
  );
}
