# Build and deploy only the server dependency graph.
FROM node:22-bookworm AS builder

RUN corepack enable && corepack prepare pnpm@10.11.0 --activate

WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY patches ./patches
COPY scripts/postinstall.cjs ./scripts/postinstall.cjs
COPY packages/hapla-wire/package.json ./packages/hapla-wire/package.json
COPY packages/hapla-server/package.json ./packages/hapla-server/package.json
COPY packages/hapla-server/prisma ./packages/hapla-server/prisma

RUN --mount=type=cache,id=hapla-pnpm,target=/root/.local/share/pnpm/store \
    SKIP_HAPLA_WIRE_BUILD=1 pnpm install --frozen-lockfile --config.node-linker=isolated \
    --filter @hapla/wire... --filter hapla-server...

COPY packages/hapla-wire ./packages/hapla-wire
COPY packages/hapla-server ./packages/hapla-server
RUN --mount=type=cache,id=hapla-pnpm,target=/root/.local/share/pnpm/store \
    pnpm --filter @hapla/wire build \
    && pnpm --filter hapla-server build \
    && npm_config_ignore_scripts=true pnpm --filter hapla-server --prod deploy --legacy --config.auto-install-peers=false /runtime \
    && cd /runtime \
    && PATH="/repo/node_modules/.bin:$PATH" prisma generate --schema prisma/schema.prisma

FROM node:22-bookworm-slim AS runner

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates ffmpeg \
    && apt-get clean \
    && find /var/lib/apt/lists -type f -delete

WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PGLITE_DIR=/data/pglite \
    PORT=3005

COPY --from=builder /runtime/ ./

VOLUME ["/data"]
EXPOSE 3005
CMD ["node_modules/.bin/tsx", "sources/standalone.ts", "serve"]
