# syntax=docker/dockerfile:1
# Build from the repo root:
#   docker build -f apps/ingest-service/Dockerfile -t stock-viewer/ingest:local .

# Keep in sync with "packageManager" in the root package.json
ARG PNPM_VERSION=11.25.0

# Prune the monorepo down to ingest-service and its workspace dependencies
FROM node:24-slim AS prune
WORKDIR /repo
RUN npm install --global turbo@2.11.7
COPY . .
RUN turbo prune ingest-service --docker

# Install dependencies, build @repo/shared and assemble a production-only tree
FROM node:24-slim AS build
ARG PNPM_VERSION
ENV CI=true
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /repo
COPY --from=prune /repo/out/json/ .
COPY --from=prune /repo/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile
COPY --from=prune /repo/out/full/ .
# ingest-service has no build step, but it imports @repo/shared from dist/
RUN pnpm --filter @repo/shared build
RUN pnpm deploy --prod --legacy --filter ingest-service /prod/ingest-service

# ingest-service runs TypeScript directly through Node's type stripping
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app/apps/ingest-service
COPY --from=build --chown=node:node /prod/ingest-service ./
USER node
EXPOSE 3003
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.CONTROL_PORT || 3003) + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# Exec form so node is PID 1 and receives SIGTERM
CMD ["node", "src/index.ts"]
