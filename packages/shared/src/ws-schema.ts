import { z } from "zod";
import type { ClientMessage } from "./ws.js";

/** Matches the free-tier WebSocket symbol limit */
export const MAX_SYMBOLS_PER_MESSAGE = 8;

// Allows EUR/USD, RY:TSX, BRK.B, BTC/USD; excludes Redis glob characters
export const SymbolSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9._:/-]+$/);

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("subscribe"),
    symbols: z.array(SymbolSchema).min(1).max(MAX_SYMBOLS_PER_MESSAGE),
  }),
  z.object({
    type: z.literal("unsubscribe"),
    symbols: z.array(SymbolSchema).min(1).max(MAX_SYMBOLS_PER_MESSAGE),
  }),
]);

// Compile-time guard that ws.ts and the schema agree
type Inferred = z.infer<typeof ClientMessageSchema>;
export type ClientMessageInSync = [Inferred] extends [ClientMessage]
  ? [ClientMessage] extends [Inferred]
    ? true
    : never
  : never;
