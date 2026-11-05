import { PrismaClient } from '@prisma/client';
import { emailSchema } from '@stockpile/shared';
import { z } from 'zod';
import { BcryptPasswordHasher } from './modules/auth/adapters/bcrypt/bcrypt-password-hasher';
import { formatAdminSeedResult, seedAdmin } from './seed/admin-seed';

const MIN_ADMIN_PASSWORD_LENGTH = 12;

const seedEnvSchema = z.object({
  DATABASE_URL: z.url(),
  ADMIN_EMAIL: emailSchema.default('admin@stockpile.local'),
  ADMIN_NAME: z.string().trim().min(1).default('Administrator'),
  ADMIN_PASSWORD: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(MIN_ADMIN_PASSWORD_LENGTH).optional(),
  ),
});

async function main(): Promise<void> {
  const parsed = seedEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid seed environment: ${issues}`);
  }
  const env = parsed.data;

  const prisma = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
  try {
    const result = await seedAdmin(prisma, new BcryptPasswordHasher(), {
      email: env.ADMIN_EMAIL,
      name: env.ADMIN_NAME,
      password: env.ADMIN_PASSWORD,
    });
    process.stdout.write(`${formatAdminSeedResult(result)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
