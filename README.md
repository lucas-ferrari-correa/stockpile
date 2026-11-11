# Stockpile

Stockpile is an inventory showcase built as a pnpm monorepo: a NestJS API with a separate BullMQ worker, PostgreSQL through Prisma, Redis, a React web app and shared Zod contracts consumed by every client.

## Running the infrastructure

```bash
pnpm install
cp .env.example .env
cp apps/api/.env.example apps/api/.env
pnpm infra:up
pnpm build
pnpm test
```

`pnpm infra:down` stops the containers and `pnpm infra:reset` recreates them from scratch and applies the database migrations. `docker compose --profile app up --build` also starts the API, the worker and the web app.

`JWT_SECRET` has no default in `docker-compose.yml`: the API and the worker containers fail at boot until it is set in the root `.env` or exported, while `pnpm infra:up` works without it. Generate one with `openssl rand -hex 32` and replace the placeholder in both `.env` files. The API and the worker refuse to start in production while the placeholder value is still in place, and the container images run with `NODE_ENV=production`.
