/** Allows EUR/USD, RY:TSX, BRK.B; excludes Redis glob characters. */
export const SYMBOL_PATTERN = /^[A-Za-z0-9._:/-]+$/;
export const SYMBOL_MAX_LENGTH = 32;

export function isValidSymbol(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= SYMBOL_MAX_LENGTH &&
    SYMBOL_PATTERN.test(value)
  );
}
