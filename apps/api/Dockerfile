# syntax=docker/dockerfile:1.7
#
# AttendSure API image. The same image runs three ways (see infra/production/compose.yml):
#   - the API:      node dist/main.js     (default command)
#   - the worker:   node dist/worker.js   (background jobs and the outbox relay)
#   - the release:  the `migrate` target applies database migrations and loads the system roles
#
# Build from the repository root:  docker build -f apps/api/Dockerfile -t attendsure-api .
# No secrets are baked in: every setting comes from the environment when the container starts.

ARG NODE_IMAGE=node:24.19.0-bookworm-slim

# ── 1. Build: all dependencies, then compile the shared package and the API ──────────────────────
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
# Every workspace's package.json, so the lockfile matches; only the API's dependencies are installed.
COPY packages/shared/package.json packages/shared/
COPY packages/design-tokens/package.json packages/design-tokens/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/mobile/package.json apps/mobile/
RUN npm ci -w @attendsure/api -w @attendsure/shared --include-workspace-root --no-audit --no-fund
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build -w @attendsure/shared && npm run build -w @attendsure/api

# ── 2. Release job: migrations and system roles (needs the Prisma command-line tool) ─────────────
FROM build AS migrate
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /app/apps/api
USER node
# Both steps are safe to repeat: applied migrations are skipped, and the seed never changes existing grants.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/database/seed.js"]

# ── 3. Production dependencies only ─────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/design-tokens/package.json packages/design-tokens/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/mobile/package.json apps/mobile/
COPY apps/api/scripts/prune-production.mjs /tmp/prune-production.mjs
# npm keeps the Prisma command-line tool (an optional peer of @prisma/client) and everything it pulls
# in; the prune script removes what the API never reaches (about 500 MB down to 200 MB).
RUN npm ci --omit=dev -w @attendsure/api -w @attendsure/shared --no-audit --no-fund \
  && node /tmp/prune-production.mjs /app \
  && mkdir -p apps/api/node_modules packages/shared/node_modules

# ── 4. Runtime: compiled code and production dependencies, run as an unprivileged user ──────────
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/package.json ./
COPY --from=prod-deps /app/node_modules node_modules
COPY --from=prod-deps /app/packages/shared/node_modules packages/shared/node_modules
COPY --from=prod-deps /app/apps/api/node_modules apps/api/node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/package.json apps/api/
COPY --from=build /app/apps/api/dist apps/api/dist
WORKDIR /app/apps/api
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
