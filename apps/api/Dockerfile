FROM node:22-alpine AS base
RUN apk add --no-cache openssl && corepack enable
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @stockpile/api...
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @stockpile/shared build \
  && pnpm --filter @stockpile/api exec prisma generate \
  && pnpm --filter @stockpile/api build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/apps/api

FROM runtime AS api
EXPOSE 3000
CMD ["sh", "-c", "pnpm exec prisma migrate deploy && exec node dist/main.js"]

FROM runtime AS worker
CMD ["node", "dist/worker.js"]
