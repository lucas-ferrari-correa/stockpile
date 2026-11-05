import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { PrismaClient, UserStatus } from '@prisma/client';
import { PERMISSIONS } from '@stockpile/shared';
import { BcryptPasswordHasher } from '../src/modules/auth/adapters/bcrypt/bcrypt-password-hasher';
import { VIEWER_PERMISSIONS, seedAdmin, seedRoles } from '../src/seed/admin-seed';

const execFileAsync = promisify(execFile);
const API_ROOT = resolve(__dirname, '..');
const ADMIN = { email: 'admin@example.test', name: 'Administrator' };
const PASSWORD = 'seeded-admin-password';

describe('admin seed', () => {
  const prisma = new PrismaClient();
  const hasher = new BcryptPasswordHasher();

  async function permissionsOf(name: string): Promise<string[]> {
    const rows = await prisma.rolePermission.findMany({
      where: { role: { name } },
      select: { permission: true },
      orderBy: { permission: 'asc' },
    });
    return rows.map(({ permission }) => permission);
  }

  async function runSeedScript(env: Record<string, string>): Promise<string> {
    const tsxCli = require.resolve('tsx/cli', { paths: [API_ROOT] });
    const { stdout } = await execFileAsync(process.execPath, [tsxCli, 'src/seed.ts'], {
      cwd: API_ROOT,
      env: { ...process.env, ...env },
    });
    return stdout;
  }

  beforeEach(async () => {
    await prisma.user.deleteMany();
    await prisma.role.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('creates the roles and one active admin whose password verifies on the first run', async () => {
    const result = await seedAdmin(prisma, hasher, { ...ADMIN, password: PASSWORD });

    expect(result).toEqual({ outcome: 'created', email: ADMIN.email, password: PASSWORD });
    const users = await prisma.user.findMany({
      select: { email: true, status: true, deletedAt: true, passwordHash: true, role: { select: { name: true, system: true } } },
    });
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ email: ADMIN.email, status: 'ACTIVE', deletedAt: null, role: { name: 'admin', system: true } });
    await expect(hasher.verify(PASSWORD, users[0]?.passwordHash ?? '')).resolves.toBe(true);
    expect(await permissionsOf('admin')).toEqual([...PERMISSIONS].sort());
    expect(await permissionsOf('viewer')).toEqual([...VIEWER_PERMISSIONS].sort());
  });

  it('generates a random password when none is provided', async () => {
    const first = await seedAdmin(prisma, hasher, ADMIN);
    await prisma.user.deleteMany();
    const second = await seedAdmin(prisma, hasher, ADMIN);

    if (first.outcome !== 'created' || second.outcome !== 'created') {
      throw new Error('Expected both runs to create the admin');
    }
    expect(first.password.length).toBeGreaterThanOrEqual(16);
    expect(second.password).not.toBe(first.password);
  });

  it('leaves the existing admin untouched on a second run', async () => {
    await seedAdmin(prisma, hasher, { ...ADMIN, password: PASSWORD });
    const before = await prisma.user.findUniqueOrThrow({ where: { email: ADMIN.email }, select: { passwordHash: true } });

    const result = await seedAdmin(prisma, hasher, { ...ADMIN, email: 'other@example.test', password: 'another-password' });

    expect(result).toEqual({ outcome: 'existing', email: ADMIN.email });
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.role.count()).toBe(2);
    const after = await prisma.user.findUniqueOrThrow({ where: { email: ADMIN.email }, select: { passwordHash: true } });
    expect(after.passwordHash).toBe(before.passwordHash);
  });

  it('keeps customised viewer permissions and restores missing admin permissions on re-seed', async () => {
    const { adminRoleId, viewerRoleId } = await seedRoles(prisma);
    await prisma.rolePermission.deleteMany({ where: { roleId: adminRoleId, permission: 'users:manage' } });
    await prisma.rolePermission.deleteMany({ where: { roleId: viewerRoleId } });
    await prisma.rolePermission.create({ data: { roleId: viewerRoleId, permission: 'inventory:write' }, select: { roleId: true } });

    await seedRoles(prisma);

    expect(await permissionsOf('admin')).toEqual([...PERMISSIONS].sort());
    expect(await permissionsOf('viewer')).toEqual(['inventory:write']);
  });

  it.each<[string, { status: UserStatus; deletedAt: Date | null }]>([
    ['blocked', { status: 'BLOCKED', deletedAt: null }],
    ['deleted', { status: 'DELETED', deletedAt: new Date() }],
  ])('reactivates a %s admin with a new password when no active admin remains', async (_label, state) => {
    await seedAdmin(prisma, hasher, { ...ADMIN, password: 'old-admin-password' });
    await prisma.user.update({ where: { email: ADMIN.email }, data: state, select: { id: true } });

    const result = await seedAdmin(prisma, hasher, { ...ADMIN, password: PASSWORD });

    expect(result).toEqual({ outcome: 'reactivated', email: ADMIN.email, password: PASSWORD });
    const admin = await prisma.user.findUniqueOrThrow({
      where: { email: ADMIN.email },
      select: { status: true, deletedAt: true, passwordHash: true },
    });
    expect(admin).toMatchObject({ status: 'ACTIVE', deletedAt: null });
    await expect(hasher.verify(PASSWORD, admin.passwordHash)).resolves.toBe(true);
    expect(await prisma.user.count()).toBe(1);
  });

  it('prints the credentials only on the run that creates the admin', async () => {
    const env = { ADMIN_EMAIL: ADMIN.email, ADMIN_NAME: ADMIN.name, ADMIN_PASSWORD: PASSWORD };

    const firstRun = await runSeedScript(env);
    const secondRun = await runSeedScript(env);

    expect(firstRun).toContain(ADMIN.email);
    expect(firstRun).toContain(PASSWORD);
    expect(secondRun).toContain(ADMIN.email);
    expect(secondRun).not.toContain(PASSWORD);
    expect(await prisma.user.count()).toBe(1);
  });
});
