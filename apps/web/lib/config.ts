const DEFAULT_API_URL = "http://localhost:3002";
const DEFAULT_SYMBOLS = "AAPL";

/** Comma-separated list; trims, drops empties and case-insensitive duplicates. */
export function parseSymbols(raw: string | undefined): string[] {
  const seen = new Set<string>();
  const symbols: string[] = [];
  for (const entry of (raw ?? "").split(",")) {
    const symbol = entry.trim();
    const key = symbol.toLowerCase();
    if (!symbol || seen.has(key)) continue;
    seen.add(key);
    symbols.push(symbol);
  }
  return symbols.length > 0 ? symbols : parseSymbols(DEFAULT_SYMBOLS);
}

// NEXT_PUBLIC_* must be referenced literally so Next can inline them.
export const config = {
  apiUrl: process.env.NEXT_PUBLIC_API_URL || DEFAULT_API_URL,
  symbols: parseSymbols(process.env.NEXT_PUBLIC_SYMBOLS),
};
