# ingest-service

Streams prices from TwelveData into Redis (live) and DynamoDB (history). In `ws` mode it also runs a small control server so symbols can be added while it is running.

## Run

```bash
cp .env.example .env   # fill in TWELVEDATA_API_KEY
pnpm dev
```

| Variable                         | Default  | Description                                                                        |
| -------------------------------- | -------- | ---------------------------------------------------------------------------------- |
| `TWELVEDATA_API_KEY`             |          | TwelveData API key                                                                 |
| `FEED_MODE`                      | `ws`     | `ws` streams ticks into the ticks table; `rest` polls quotes into the quotes table |
| `SYMBOLS`                        | `AAPL`   | Pinned symbols: subscribed at boot and never removed                               |
| `REDIS_URL`                      |          | Redis to publish to (`redis://` or `rediss://`)                                    |
| `AWS_REGION`, `AWS_ENDPOINT_URL` |          | DynamoDB (Floci locally)                                                           |
| `TICKS_TABLE_NAME`               |          | `ws` mode table                                                                    |
| `DYNAMODB_TABLE_NAME`            |          | `rest` mode table                                                                  |
| `POLL_INTERVAL_MS`               | `60000`  | `rest` mode polling interval                                                       |
| `INGEST_TOKEN`                   |          | `ws` mode only. Shared secret for the control server; must equal the API's         |
| `CONTROL_PORT`                   | `3003`   | Port of the control server                                                         |
| `MAX_SYMBOLS`                    | `8`      | Pinned plus dynamic symbols allowed at once                                        |
| `IDLE_TTL_MS`                    | `600000` | Dynamic symbols not requested for this long are unsubscribed                       |

## Subscribing to any symbol

Any symbol TwelveData supports can be streamed without restarting ingest.

```
browser ── POST /subscriptions ──► api ── POST /subscriptions + x-ingest-token ──► ingest ──► TwelveData
browser ◄── Socket.IO tick ◄────── api ◄── Redis ticks:{symbol} ◄───────────────── ingest
```

The control server is only meant to be called by the API. Keep its port off the public network.

```bash
curl -X POST localhost:3003/subscriptions \
  -H 'x-ingest-token: <INGEST_TOKEN>' -H 'content-type: application/json' \
  -d '{"symbol":"NVDA"}'

curl localhost:3003/subscriptions -H 'x-ingest-token: <INGEST_TOKEN>'   # {"pinned":[...],"dynamic":[...]}
```

`POST` is idempotent: repeating it for a subscribed symbol returns `200` and resets its idle timer.

| Status | Body                      | Meaning                                             |
| ------ | ------------------------- | --------------------------------------------------- |
| `200`  | `{"symbol":"NVDA"}`       | Subscribed                                          |
| `400`  | `{"error":"invalid"}`     | Not a valid symbol                                  |
| `422`  | `{"error":"unsupported"}` | TwelveData rejected it, or did not answer within 5s |
| `409`  | `{"error":"capacity"}`    | `MAX_SYMBOLS` reached; nothing is evicted           |
| `401`  |                           | Missing or wrong `x-ingest-token`                   |

### Limits and lifetime

- The free TwelveData plan allows 8 WebSocket symbols in total. `SYMBOLS` counts towards `MAX_SYMBOLS` (default 8), so with 2 pinned symbols only 6 dynamic ones fit.
- Only one ingest instance should run per API key.
- A dynamic symbol is unsubscribed after `IDLE_TTL_MS` without a request. The API repeats the request every 3 minutes while a client is subscribed to the symbol.
- Dynamic symbols are mirrored in the Redis set `dynamic:symbols`. They are not re-subscribed on restart.
- The control server is disabled in `rest` mode.

## Run in Docker

The image is built from the repo root (it needs the workspace lockfile and `@repo/shared`). `.env` is never copied into the image; compose injects it at runtime.

```bash
cp apps/ingest-service/.env.example apps/ingest-service/.env   # fill in TWELVEDATA_API_KEY
docker compose up -d floci redis                               # Floci must be up before Terraform
pnpm infra:init && (cd infra && terraform apply)               # creates the ticks table in Floci
docker compose --profile app up --build ingest
```

The `ingest` service sits behind the `app` compose profile, so a plain `docker compose up` still starts only redis and floci. Compose overrides `REDIS_URL` with `redis://redis:6379` and `AWS_ENDPOINT_URL` with `http://floci:4566`, so a `.env` written for `pnpm dev` works unchanged. The `ticks` table comes from Terraform (`infra/`), so run `terraform apply` again if Floci's `./data` was wiped.

To build and run the image on its own:

```bash
docker build -f apps/ingest-service/Dockerfile -t stock-viewer/ingest:local .
docker run --rm --env-file apps/ingest-service/.env -e REDIS_URL=... -e AWS_ENDPOINT_URL=... -p 3003:3003 stock-viewer/ingest:local
```

- The container runs as the non-root `node` user and `node` is PID 1, so `docker stop` delivers `SIGTERM` and shuts down cleanly (exit `0`).
- `GET /health` returns `200` without a token and is the only unauthenticated route; the container healthcheck uses it.
- Only one instance may use a TwelveData key, so stop any local `pnpm dev` ingest before starting the container.
