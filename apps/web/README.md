# web

Next.js app showing live stock and FX prices from the `api` Socket.IO gateway.

## Setup

```bash
cp .env.example .env.local   # optional; defaults match the example
pnpm dev                     # http://localhost:3000 (redirects to /live)
```

| Variable | Default | Description |
| --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | `http://localhost:3002` | Base URL of `apps/api` |
| `NEXT_PUBLIC_SYMBOLS` | `AAPL,EUR/USD` | Symbols in the picker; keep equal to the api/ingest `SYMBOLS` |

`NEXT_PUBLIC_*` values are inlined at build time.

## Pages

- `/live`: symbol picker, live price with up/down flash, connection status. Re-subscribes automatically after a reconnect.
