const STORAGE_KEY = "stock-viewer:recent-symbols";
export const MAX_RECENT = 8;

/** Most recent first. Empty on the server or when storage is unavailable. */
export function loadRecentSymbols(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? "[]",
    );
    if (!Array.isArray(parsed)) return [];
    return dedupe(parsed.filter((s): s is string => typeof s === "string"));
  } catch {
    return [];
  }
}

/** Puts `symbol` first, persists the list and returns it. */
export function addRecentSymbol(symbol: string): string[] {
  const next = dedupe([symbol, ...loadRecentSymbols()]);
  if (typeof window === "undefined") return next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // storage full or blocked: the in-memory list still works
  }
  return next;
}

function dedupe(symbols: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const symbol of symbols) {
    const key = symbol.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(symbol);
  }
  return result.slice(0, MAX_RECENT);
}
