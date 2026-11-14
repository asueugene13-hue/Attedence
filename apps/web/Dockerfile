# syntax=docker/dockerfile:1.7
#
# AttendSure web dashboard image (Next.js standalone server).
# Build from the repository root:  docker build -f apps/web/Dockerfile -t attendsure-web .
#
# In production the reverse proxy sends /api/* straight to the API instances. The dashboard's own
# /api/v1 forwarding (next.config.ts) is fixed when the image is built, so API_INTERNAL_URL is a build
# argument; it is only a fallback for requests that reach the dashboard directly.

ARG NODE_IMAGE=node:24.19.0-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
ARG API_INTERNAL_URL=http://api:3000
# The file store's public address (S3_PUBLIC_ENDPOINT): the only other place the browser may load images from.
ARG FILES_ORIGIN
RUN test -n "$FILES_ORIGIN" || (echo "Set the FILES_ORIGIN build argument (the file store's public address)." && exit 1)
ENV API_INTERNAL_URL=${API_INTERNAL_URL} \
    FILES_ORIGIN=${FILES_ORIGIN} \
    NEXT_OUTPUT_STANDALONE=true \
    NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/design-tokens/package.json packages/design-tokens/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/mobile/package.json apps/mobile/
RUN npm ci -w @attendsure/web -w @attendsure/shared -w @attendsure/design-tokens --include-workspace-root --no-audit --no-fund
COPY packages packages
COPY apps/web apps/web
RUN npm run build -w @attendsure/shared -w @attendsure/design-tokens && npm run build -w @attendsure/web

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3001 \
    HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public apps/web/public
USER node
EXPOSE 3001
CMD ["node", "apps/web/server.js"]
