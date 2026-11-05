import { randomBytes } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { PERMISSIONS, Permission } from '@stockpile/shared';
import { PasswordHasher } from '../modules/auth/ports/password-hasher.port';

export const GENERATED_PASSWORD_BYTES = 18;

export const ADMIN_ROLE_NAME = 'admin';

export const VIEWER_ROLE_NAME = 'viewer';

export const ADMIN_PERMISSIONS: readonly Permission[] = PERMISSIONS;

export const VIEWER_PERMISSIONS: readonly Permission[] = ['inventory:read', 'dashboard:view'];

export interface AdminSeedOptions {
  email: string;
  name: string;
  password?: string;
}

export type AdminSeedResult =
  | { outcome: 'existing'; email: string }
  | { outcome: 'created' | 'reactivated'; email: string; password: string };

export function generateAdminPassword(): string {
  return randomBytes(GENERATED_PASSWORD_BYTES).toString('base64url');
}

export async function seedRoles(prisma: PrismaClient): Promise<{ adminRoleId: string; viewerRoleId: string }> {
  const admin = await prisma.role.upsert({
    where: { name: ADMIN_ROLE_NAME },
    create: {
      name: ADMIN_ROLE_NAME,
      system: true,
      permissions: { createMany: { data: ADMIN_PERMISSIONS.map((permission) => ({ permission })) } },
    },
    update: {
      system: true,
      permissions: { createMany: { data: ADMIN_PERMISSIONS.map((permission) => ({ permission })), skipDuplicates: true } },
    },
    select: { id: true },
  });

  const viewer = await prisma.role.upsert({
    where: { name: VIEWER_ROLE_NAME },
    create: {
      name: VIEWER_ROLE_NAME,
      system: false,
      permissions: { createMany: { data: VIEWER_PERMISSIONS.map((permission) => ({ permission })) } },
    },
    update: {},
    select: { id: true },
  });

  return { adminRoleId: admin.id, viewerRoleId: viewer.id };
}

export async function seedAdmin(
  prisma: PrismaClient,
  hasher: PasswordHasher,
  options: AdminSeedOptions,
): Promise<AdminSeedResult> {
  const { adminRoleId } = await seedRoles(prisma);

  const activeAdmin = await prisma.user.findFirst({
    where: { roleId: adminRoleId, status: 'ACTIVE', deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { email: true },
  });
  if (activeAdmin) {
    return { outcome: 'existing', email: activeAdmin.email };
  }

  const password = options.password ?? generateAdminPassword();
  const passwordHash = await hasher.hash(password);

  const reactivated = await prisma.user.updateMany({
    where: {
      email: options.email,
      OR: [{ roleId: { not: adminRoleId } }, { status: { not: 'ACTIVE' } }, { deletedAt: { not: null } }],
    },
    data: { roleId: adminRoleId, status: 'ACTIVE', deletedAt: null, passwordHash },
  });
  if (reactivated.count > 0) {
    return { outcome: 'reactivated', email: options.email, password };
  }

  try {
    await prisma.user.create({
      data: { name: options.name, email: options.email, passwordHash, roleId: adminRoleId, status: 'ACTIVE' },
      select: { id: true },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return { outcome: 'existing', email: options.email };
    }
    throw error;
  }
  return { outcome: 'created', email: options.email, password };
}

const BANNER = '==============================================';

export function formatAdminSeedResult(result: AdminSeedResult): string {
  if (result.outcome === 'existing') {
    return `Admin account already exists (${result.email}). No credentials printed.`;
  }
  const title = result.outcome === 'created' ? 'Admin account created' : 'Admin account reactivated';
  return [
    BANNER,
    ` ${title}`,
    ` Email:    ${result.email}`,
    ` Password: ${result.password}`,
    ' Store it now: it will not be shown again.',
    BANNER,
  ].join('\n');
}
