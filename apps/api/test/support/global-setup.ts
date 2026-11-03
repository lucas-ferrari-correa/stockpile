import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { loadTestEnv, TEST_DATABASE_SCHEMA } from './test-env';

async function dropTestSchema(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${TEST_DATABASE_SCHEMA}" CASCADE`);
  } finally {
    await prisma.$disconnect();
  }
}

export default async function globalSetup(): Promise<void> {
  loadTestEnv();
  await dropTestSchema();
  const apiRoot = resolve(__dirname, '../..');
  const prismaCli = require.resolve('prisma/build/index.js', { paths: [apiRoot] });
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: apiRoot,
    env: process.env,
    stdio: 'pipe',
  });
}
