import { DEFAULT_CONVERSION_CURRENCIES, currencyListSchema } from '@stockpile/shared';
import { z } from 'zod';

export const MIN_JWT_SECRET_LENGTH = 32;

export const DEFAULT_JWT_EXPIRES_IN_SECONDS = 3600;

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  EXCHANGE_CURRENCIES: currencyListSchema.default([...DEFAULT_CONVERSION_CURRENCIES]),
  JWT_SECRET: z.string().min(MIN_JWT_SECRET_LENGTH),
  JWT_EXPIRES_IN_SECONDS: z.coerce.number().int().positive().default(DEFAULT_JWT_EXPIRES_IN_SECONDS),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  return result.data;
}
