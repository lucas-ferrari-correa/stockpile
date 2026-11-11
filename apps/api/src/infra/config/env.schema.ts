import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_CONVERSION_CURRENCIES, currencyListSchema } from '@stockpile/shared';
import { z } from 'zod';

export const MIN_JWT_SECRET_LENGTH = 32;

export const DEFAULT_JWT_EXPIRES_IN_SECONDS = 3600;

export const JWT_SECRET_PLACEHOLDER = 'replace-me-with-the-output-of-openssl-rand-hex-32';

export const DEFAULT_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  EXCHANGE_CURRENCIES: currencyListSchema.default([...DEFAULT_CONVERSION_CURRENCIES]),
  EXCHANGE_RATES_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  JWT_SECRET: z.string().min(MIN_JWT_SECRET_LENGTH),
  JWT_EXPIRES_IN_SECONDS: z.coerce.number().int().positive().default(DEFAULT_JWT_EXPIRES_IN_SECONDS),
  UPLOAD_DIR: z
    .string()
    .trim()
    .min(1)
    .default(join(tmpdir(), 'stockpile-uploads'))
    .transform((value) => resolve(value)),
  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(DEFAULT_UPLOAD_MAX_BYTES),
  IMPORT_CONCURRENCY: z.coerce.number().int().positive().default(2),
  IMPORT_JOB_ATTEMPTS: z.coerce.number().int().positive().default(3),
  IMPORT_JOB_BACKOFF_MS: z.coerce.number().int().positive().default(1000),
  IMPORT_RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(30000),
  IMPORT_RECONCILE_AFTER_MS: z.coerce.number().int().positive().default(60000),
  THROTTLE_LOGIN_LIMIT: z.coerce.number().int().positive().default(5),
  THROTTLE_LOGIN_TTL_MS: z.coerce.number().int().positive().default(60000),
  THROTTLE_ACCESS_REQUEST_LIMIT: z.coerce.number().int().positive().default(3),
  THROTTLE_ACCESS_REQUEST_TTL_MS: z.coerce.number().int().positive().default(3600000),
  TRUST_PROXY_HOPS: z.coerce.number().int().nonnegative().default(0),
}).superRefine((env, context) => {
  if (env.NODE_ENV === 'production' && env.JWT_SECRET === JWT_SECRET_PLACEHOLDER) {
    context.addIssue({
      code: 'custom',
      path: ['JWT_SECRET'],
      message: 'must be replaced with a generated secret in production',
    });
  }
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
