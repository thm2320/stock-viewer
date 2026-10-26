# web

Next.js app showing live stock and FX prices from the `api` Socket.IO gateway.

## Setup

```bash
cp .env.example .env.local   # optional; defaults match the example
pnpm dev                     # http://localhost:3000 (redirects to /live)
```

| Variable              | Default                 | Description                                                                           |
| --------------------- | ----------------------- | ------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_API_URL` | `http://localhost:3002` | Base URL of `apps/api`                                                                |
| `NEXT_PUBLIC_SYMBOLS` | `AAPL`                  | Quick-pick chips shown next to recent symbols; any other valid symbol can be typed in |

`NEXT_PUBLIC_*` values are inlined at build time.

## Pages

- `/live`: type any symbol or click a chip, then see its live price with up/down flash and connection status.
  - Subscribing first calls `POST /subscriptions` on the api, which asks ingest to start streaming the symbol, then joins the symbol's Socket.IO room. The previous symbol stays selected if the request fails, and the reason is shown under the input.
  - Recent symbols are kept in `localStorage` (latest 8).
  - Re-subscribes automatically after a reconnect.
  - See `apps/ingest-service/README.md` for error codes and the free-tier limit of 8 symbols.
