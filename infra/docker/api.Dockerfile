# syntax=docker/dockerfile:1.7
# Multi-stage: base -> deps -> dev | build -> runner

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
RUN apk add --no-cache tini curl
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

# ── deps: install once, cached on lockfile only ──────────────
FROM base AS deps
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/api/package.json          apps/api/
COPY apps/worker/package.json       apps/worker/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json        packages/db/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile=false

# ── dev: hot reload, source bind-mounted at runtime ──────────
FROM deps AS dev
ENV NODE_ENV=development
COPY . .
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["pnpm", "--filter", "@ct/api", "dev"]

# ── build: compile to dist ───────────────────────────────────
FROM deps AS build
COPY . .
RUN pnpm --filter @ct/contracts build \
 && pnpm --filter @ct/db build \
 && pnpm --filter @ct/api build \
 && pnpm --filter @ct/worker build

# ── runner: production image, non-root ───────────────────────
FROM base AS runner
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build /app/apps/api/dist          ./dist/apps/api
COPY --from=build /app/apps/api/node_modules  ./apps/api/node_modules
COPY --from=build /app/apps/worker/dist       ./dist/apps/worker
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /app/packages/db/dist        ./packages/db/dist
COPY --from=build /app/packages/db/package.json ./packages/db/package.json
COPY --from=build /app/packages/db/migrations  ./packages/db/migrations
COPY --from=build /app/packages/db/seeds       ./packages/db/seeds
USER node
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/apps/api/src/main.js"]
