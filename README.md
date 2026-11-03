# Stockpile

Stockpile is an inventory showcase built as a pnpm monorepo: a NestJS API with a separate BullMQ worker, PostgreSQL through Prisma, Redis, a React web app and shared Zod contracts consumed by every client.

## Running the infrastructure

```bash
pnpm install
cp apps/api/.env.example apps/api/.env
pnpm infra:up
pnpm build
pnpm test
```

`pnpm infra:down` stops the containers and `pnpm infra:reset` recreates them from scratch and applies the database migrations. `docker compose --profile app up --build` also starts the API, the worker and the web app.
