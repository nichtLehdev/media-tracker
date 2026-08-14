# syntax=docker/dockerfile:1

# web and worker ship as the same image with different entrypoints (S17).
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV CI=1

# --- dependencies ----------------------------------------------------------
# Only the manifests are copied first so this layer caches across source edits.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/tmdb/package.json packages/tmdb/package.json
RUN pnpm install --frozen-lockfile

# --- build -----------------------------------------------------------------
FROM deps AS build
COPY . .
# The Next build imports server modules to collect page data; it must not need
# production secrets to do that. Runtime validation stays strict.
ENV SKIP_ENV_VALIDATION=1
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @media-tracker/web build

# --- runtime ---------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app /app
RUN addgroup -g 1001 -S tracker && adduser -u 1001 -S tracker -G tracker \
  && chown -R tracker:tracker /app
USER tracker
EXPOSE 3000
CMD ["pnpm", "--filter", "@media-tracker/web", "start"]
