import { resolve } from 'node:path';
import { config } from 'dotenv';

export const TEST_DATABASE_SCHEMA = 'test';

function withSchema(databaseUrl: string, schema: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set('schema', schema);
  return url.toString();
}

export function loadTestEnv(schema: string = TEST_DATABASE_SCHEMA): void {
  const parsed = config({ path: resolve(__dirname, '../../.env.example'), quiet: true, processEnv: {} }).parsed ?? {};
  const baseDatabaseUrl = parsed.DATABASE_URL;
  if (!baseDatabaseUrl) {
    throw new Error('DATABASE_URL is missing from .env.example');
  }

  Object.assign(process.env, parsed, {
    NODE_ENV: 'test',
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'silent',
    DATABASE_URL: withSchema(baseDatabaseUrl, schema),
    THROTTLE_LOGIN_LIMIT: '100000',
    THROTTLE_ACCESS_REQUEST_LIMIT: '100000',
  });
}
