import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import {
  PERMISSIONS,
  Permission,
  RoleError,
  UserStatus,
  authErrorSchema,
  loginResponseSchema,
  roleErrorSchema,
  roleListSchema,
  roleSchema,
} from '@stockpile/shared';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { PASSWORD_HASHER, PasswordHasher } from '../src/modules/auth/ports/password-hasher.port';
import { seedRoles } from '../src/seed/admin-seed';

const PASSWORD = 'roles-password-0123';
const GOVERNANCE: readonly Permission[] = ['users:manage', 'roles:manage'];

interface UserSeed {
  status?: UserStatus;
  roleId: string | null;
  deletedAt?: Date | null;
}

interface RoleRow {
  name: string;
  permissions: string[];
}

type Call = (token?: string) => request.Test;

describe('roles', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let passwordHash: string;
  let adminRoleId: string;
  let viewerRoleId: string;

  async function createRole(permissions: readonly Permission[], name: string = `custom-${randomUUID()}`): Promise<string> {
    const role = await prisma.role.create({
      data: { name, permissions: { createMany: { data: permissions.map((permission) => ({ permission })) } } },
      select: { id: true },
    });
    return role.id;
  }

  async function seedUser(seed: UserSeed): Promise<{ id: string; email: string }> {
    return prisma.user.create({
      data: {
        name: 'Role Holder',
        email: `${randomUUID()}@example.test`,
        passwordHash,
        status: seed.status ?? 'ACTIVE',
        roleId: seed.roleId,
        deletedAt: seed.deletedAt ?? null,
      },
      select: { id: true, email: true },
    });
  }

  async function tokenFor(email: string): Promise<string> {
    const response = await request(app.getHttpServer()).post('/auth/login').send({ email, password: PASSWORD }).expect(200);
    return loginResponseSchema.parse(response.body).accessToken;
  }

  async function tokenWith(permissions: readonly Permission[]): Promise<string> {
    const user = await seedUser({ roleId: await createRole(permissions) });
    return tokenFor(user.email);
  }

  async function governorToken(): Promise<string> {
    return tokenWith(GOVERNANCE);
  }

  function withToken(pending: request.Test, token?: string): request.Test {
    return token === undefined ? pending : pending.auth(token, { type: 'bearer' });
  }

  function listRoles(token?: string): request.Test {
    return withToken(request(app.getHttpServer()).get('/roles'), token);
  }

  function getRole(id: string, token?: string): request.Test {
    return withToken(request(app.getHttpServer()).get(`/roles/${id}`), token);
  }

  function createRoleRequest(body: object, token?: string): request.Test {
    return withToken(request(app.getHttpServer()).post('/roles').send(body), token);
  }

  function updateRole(id: string, body: object, token?: string): request.Test {
    return withToken(request(app.getHttpServer()).patch(`/roles/${id}`).send(body), token);
  }

  function deleteRole(id: string, token?: string): request.Test {
    return withToken(request(app.getHttpServer()).delete(`/roles/${id}`), token);
  }

  function listUsers(token?: string): request.Test {
    return withToken(request(app.getHttpServer()).get('/users'), token);
  }

  function roleError(body: unknown): RoleError {
    return roleErrorSchema.parse(body);
  }

  function authErrorCode(body: unknown): string {
    return authErrorSchema.parse(body).code;
  }

  async function roleRow(id: string): Promise<RoleRow | null> {
    const row = await prisma.role.findUnique({
      where: { id },
      select: { name: true, permissions: { select: { permission: true }, orderBy: { permission: 'asc' } } },
    });
    return row === null ? null : { name: row.name, permissions: row.permissions.map(({ permission }) => permission) };
  }

  async function userCountOf(id: string, token: string): Promise<number | undefined> {
    const response = await listRoles(token).expect(200);
    return roleListSchema.parse(response.body).items.find((item) => item.id === id)?.userCount;
  }

  function sorted(permissions: readonly string[]): string[] {
    return [...permissions].sort();
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    passwordHash = await app.get<PasswordHasher>(PASSWORD_HASHER).hash(PASSWORD);
  });

  beforeEach(async () => {
    await prisma.user.deleteMany();
    await prisma.role.deleteMany();
    ({ adminRoleId, viewerRoleId } = await seedRoles(prisma));
  });

  afterAll(async () => {
    await app.close();
  });

  describe('crud', () => {
    it('creates, reads, renames, re-permissions and deletes a role, counting only non-deleted users', async () => {
      const token = await governorToken();

      const created = await createRoleRequest(
        { name: '  Auditor  ', permissions: ['inventory:read', 'dashboard:view'] },
        token,
      ).expect(201);

      const role = roleSchema.parse(created.body);
      expect(role).toMatchObject({ name: 'Auditor', system: false });
      expect(sorted(role.permissions)).toEqual(['dashboard:view', 'inventory:read']);
      expect(await roleRow(role.id)).toEqual({ name: 'Auditor', permissions: ['dashboard:view', 'inventory:read'] });

      const fetched = await getRole(role.id, token).expect(200);
      expect(roleSchema.parse(fetched.body)).toEqual(role);

      await seedUser({ roleId: role.id });
      await seedUser({ roleId: role.id, status: 'BLOCKED' });
      await seedUser({ roleId: role.id, status: 'DELETED', deletedAt: new Date() });
      const listed = await listRoles(token).expect(200);
      const items = roleListSchema.parse(listed.body).items;
      expect(items.map((item) => item.name)).toEqual(['admin', 'Auditor', expect.stringMatching(/^custom-/), 'viewer']);
      expect(items.find((item) => item.id === role.id)).toEqual({ ...role, userCount: 2 });
      expect(items.find((item) => item.id === adminRoleId)).toMatchObject({ system: true, userCount: 0 });
      expect(sorted(items.find((item) => item.id === adminRoleId)?.permissions ?? [])).toEqual(sorted(PERMISSIONS));

      const renamed = await updateRole(role.id, { name: 'Inventory auditor' }, token).expect(200);
      expect(roleSchema.parse(renamed.body)).toMatchObject({ id: role.id, name: 'Inventory auditor' });
      expect(sorted(roleSchema.parse(renamed.body).permissions)).toEqual(['dashboard:view', 'inventory:read']);

      const repermissioned = await updateRole(role.id, { permissions: ['inventory:write'] }, token).expect(200);
      expect(roleSchema.parse(repermissioned.body)).toMatchObject({
        name: 'Inventory auditor',
        permissions: ['inventory:write'],
      });
      expect(await roleRow(role.id)).toEqual({ name: 'Inventory auditor', permissions: ['inventory:write'] });

      await prisma.user.deleteMany({ where: { roleId: role.id, deletedAt: null } });
      await deleteRole(role.id, token).expect(204);

      expect(await roleRow(role.id)).toBeNull();
      const gone = await getRole(role.id, token).expect(404);
      expect(gone.body).toEqual({ statusCode: 404, code: 'ROLE_NOT_FOUND', message: 'Role not found' } satisfies RoleError);
    });

    it('accepts a role with no permissions and a patch that empties them', async () => {
      const token = await governorToken();

      const created = await createRoleRequest({ name: 'Placeholder', permissions: [] }, token).expect(201);
      const id = roleSchema.parse(created.body).id;
      await updateRole(id, { permissions: ['inventory:read'] }, token).expect(200);
      const emptied = await updateRole(id, { permissions: [] }, token).expect(200);

      expect(roleSchema.parse(emptied.body).permissions).toEqual([]);
      expect(await roleRow(id)).toEqual({ name: 'Placeholder', permissions: [] });
    });

    it('lets a role keep its own name with a different case', async () => {
      const token = await governorToken();
      const id = await createRole(['inventory:read'], 'Ops');

      const response = await updateRole(id, { name: 'OPS' }, token).expect(200);

      expect(roleSchema.parse(response.body).name).toBe('OPS');
    });

    it.each<[string, (id: string, token: string) => request.Test]>([
      ['get', (id, token) => getRole(id, token)],
      ['patch', (id, token) => updateRole(id, { name: 'Ghost' }, token)],
      ['delete', (id, token) => deleteRole(id, token)],
    ])('answers %s on an unknown id with 404 ROLE_NOT_FOUND', async (_name, call) => {
      const token = await governorToken();

      const response = await call(randomUUID(), token).expect(404);

      expect(roleError(response.body).code).toBe('ROLE_NOT_FOUND');
    });

    it.each<[string, (token: string) => request.Test]>([
      ['get', (token) => getRole('not-a-uuid', token)],
      ['patch', (token) => updateRole('not-a-uuid', { name: 'Ghost' }, token)],
      ['delete', (token) => deleteRole('not-a-uuid', token)],
    ])('answers %s with a non-uuid id with 400', async (_name, call) => {
      await call(await governorToken()).expect(400);
    });
  });

  describe('system role', () => {
    it.each<[string, (token: string) => request.Test]>([
      ['patching its name', (token) => updateRole(adminRoleId, { name: 'root' }, token)],
      ['patching its permissions', (token) => updateRole(adminRoleId, { permissions: ['inventory:read'] }, token)],
      ['deleting it', (token) => deleteRole(adminRoleId, token)],
    ])('refuses %s with 409 SYSTEM_ROLE_IMMUTABLE and keeps it intact', async (_name, call) => {
      const before = await roleRow(adminRoleId);

      const response = await call(await governorToken()).expect(409);

      expect(response.body).toEqual({
        statusCode: 409,
        code: 'SYSTEM_ROLE_IMMUTABLE',
        message: 'System roles cannot be changed or deleted',
      } satisfies RoleError);
      expect(await roleRow(adminRoleId)).toEqual(before);
    });
  });

  describe('name uniqueness', () => {
    it('refuses a create whose name differs from an existing one only by case and spaces', async () => {
      const token = await governorToken();
      await createRoleRequest({ name: 'Ops', permissions: [] }, token).expect(201);

      const response = await createRoleRequest({ name: ' ops ', permissions: ['inventory:read'] }, token).expect(409);

      expect(response.body).toEqual({
        statusCode: 409,
        code: 'ROLE_NAME_TAKEN',
        message: 'A role with this name already exists',
      } satisfies RoleError);
      expect(await prisma.role.count({ where: { name: { equals: 'ops', mode: 'insensitive' } } })).toBe(1);
    });

    it('refuses a rename to another role name differing only by case and spaces', async () => {
      const token = await governorToken();
      await createRole([], 'Ops');
      const otherId = await createRole(['inventory:read'], 'Support');

      const response = await updateRole(otherId, { name: ' OPS ' }, token).expect(409);

      expect(roleError(response.body).code).toBe('ROLE_NAME_TAKEN');
      expect(await roleRow(otherId)).toEqual({ name: 'Support', permissions: ['inventory:read'] });
    });

    it('treats underscore and percent as literal characters when comparing names', async () => {
      const token = await governorToken();
      await createRole([], 'axb');

      await createRoleRequest({ name: 'A_b', permissions: [] }, token).expect(201);
      await createRoleRequest({ name: 'A%', permissions: [] }, token).expect(201);
      const duplicate = await createRoleRequest({ name: 'a_B', permissions: [] }, token).expect(409);

      expect(roleError(duplicate.body).code).toBe('ROLE_NAME_TAKEN');
    });

    it('lets exactly one of two simultaneous creates with names differing by case succeed', async () => {
      const token = await governorToken();

      const responses = await Promise.all([
        createRoleRequest({ name: 'Ops', permissions: [] }, token),
        createRoleRequest({ name: 'ops', permissions: [] }, token),
      ]);

      expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
      const conflict = responses.find((response) => response.status === 409);
      expect(roleError(conflict?.body).code).toBe('ROLE_NAME_TAKEN');
      expect(await prisma.role.count({ where: { name: { equals: 'ops', mode: 'insensitive' } } })).toBe(1);
    });

    it('enforces case-insensitive uniqueness in the database itself', async () => {
      await createRole([], 'Ops');

      const attempt = prisma.role.create({ data: { name: 'oPS' }, select: { id: true } });

      await expect(attempt).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      await expect(attempt).rejects.toMatchObject({ code: 'P2002' });
    });
  });

  describe('validation', () => {
    it.each<[string, object]>([
      ['a permission outside the catalog', { name: 'Bad', permissions: ['inventory:delete'] }],
      ['a duplicated permission', { name: 'Bad', permissions: ['inventory:read', 'inventory:read'] }],
      ['a blank name', { name: '   ', permissions: [] }],
      ['a name longer than 64 characters', { name: 'x'.repeat(65), permissions: [] }],
      ['no permissions field', { name: 'Bad' }],
    ])('rejects a create with %s and stores nothing', async (_label, body) => {
      const token = await governorToken();
      const before = await prisma.role.count();

      await createRoleRequest(body, token).expect(400);

      expect(await prisma.role.count()).toBe(before);
    });

    it.each<[string, object]>([
      ['an empty body', {}],
      ['a permission outside the catalog', { permissions: ['roles:read'] }],
      ['a duplicated permission', { permissions: ['dashboard:view', 'dashboard:view'] }],
      ['a blank name', { name: '' }],
    ])('rejects a patch with %s and changes nothing', async (_label, body) => {
      const token = await governorToken();
      const id = await createRole(['inventory:read'], 'Steady');

      await updateRole(id, body, token).expect(400);

      expect(await roleRow(id)).toEqual({ name: 'Steady', permissions: ['inventory:read'] });
    });
  });

  describe('deletion', () => {
    it('refuses to delete a role with non-deleted users and reports how many', async () => {
      const token = await governorToken();
      const id = await createRole(['inventory:read']);
      await seedUser({ roleId: id });
      await seedUser({ roleId: id, status: 'BLOCKED' });
      await seedUser({ roleId: id, status: 'DELETED', deletedAt: new Date() });

      const response = await deleteRole(id, token).expect(409);

      expect(response.body).toEqual({
        statusCode: 409,
        code: 'ROLE_IN_USE',
        message: 'The role is assigned to users and cannot be deleted',
        userCount: 2,
      } satisfies RoleError);
      expect(await roleRow(id)).not.toBeNull();
      expect(await prisma.user.count({ where: { roleId: id } })).toBe(3);
    });

    it('deletes a role held only by soft-deleted users and clears their role', async () => {
      const token = await governorToken();
      const id = await createRole(['inventory:read']);
      const deleted = await seedUser({ roleId: id, status: 'DELETED', deletedAt: new Date() });
      const bystander = await seedUser({ roleId: viewerRoleId, status: 'DELETED', deletedAt: new Date() });
      expect(await userCountOf(id, token)).toBe(0);

      await deleteRole(id, token).expect(204);

      expect(await roleRow(id)).toBeNull();
      const users = await prisma.user.findMany({
        where: { id: { in: [deleted.id, bystander.id] } },
        select: { id: true, roleId: true, status: true },
      });
      expect(users).toEqual(
        expect.arrayContaining([
          { id: deleted.id, roleId: null, status: 'DELETED' },
          { id: bystander.id, roleId: viewerRoleId, status: 'DELETED' },
        ]),
      );
    });
  });

  describe('permissions per route', () => {
    const ROUTE_BY_PERMISSION: ReadonlyArray<[Permission, Call]> = [
      ['users:manage', (token) => listUsers(token)],
      ['roles:manage', (token) => listRoles(token)],
    ];

    it.each(ROUTE_BY_PERMISSION)(
      'lets a custom role holding only %s reach its route and nothing else',
      async (permission, allowed) => {
        const token = await tokenWith([permission]);

        await allowed(token).expect(200);

        for (const [other, call] of ROUTE_BY_PERMISSION) {
          if (other === permission) {
            continue;
          }
          const denied = await call(token).expect(403);
          expect(authErrorCode(denied.body)).toBe('ACCESS_DENIED');
        }
      },
    );

    it('applies permission changes to the role holders on the next request with the same token', async () => {
      const governor = await governorToken();
      const roleId = await createRole(['roles:manage']);
      const holder = await seedUser({ roleId });
      const token = await tokenFor(holder.email);
      await listRoles(token).expect(200);
      await listUsers(token).expect(403);

      await updateRole(roleId, { permissions: ['users:manage'] }, governor).expect(200);

      const denied = await listRoles(token).expect(403);
      expect(authErrorCode(denied.body)).toBe('ACCESS_DENIED');
      await listUsers(token).expect(200);
    });
  });

  describe('access control', () => {
    const ROUTE_CASES: ReadonlyArray<[string, (id: string, token?: string) => request.Test]> = [
      ['list', (_id, token) => listRoles(token)],
      ['get', (id, token) => getRole(id, token)],
      ['create', (_id, token) => createRoleRequest({ name: 'Intruder', permissions: [] }, token)],
      ['patch', (id, token) => updateRole(id, { name: 'Intruder' }, token)],
      ['delete', (id, token) => deleteRole(id, token)],
    ];

    it.each(ROUTE_CASES)(
      'answers %s with 401 without a token or with a bogus bearer and 403 for every permission but roles:manage',
      async (_name, call) => {
        const target = await createRole(['inventory:read'], 'Target');
        const token = await tokenWith(PERMISSIONS.filter((permission) => permission !== 'roles:manage'));

        const anonymous = await call(target).expect(401);
        const bogus = await call(target, 'not-a-jwt').expect(401);
        const forbidden = await call(target, token).expect(403);

        expect(authErrorCode(anonymous.body)).toBe('UNAUTHENTICATED');
        expect(authErrorCode(bogus.body)).toBe('UNAUTHENTICATED');
        expect(authErrorCode(forbidden.body)).toBe('ACCESS_DENIED');
        expect(await roleRow(target)).toEqual({ name: 'Target', permissions: ['inventory:read'] });
        expect(await prisma.role.count({ where: { name: 'Intruder' } })).toBe(0);
      },
    );
  });

  describe('last governor protection', () => {
    it.each<[string, Permission[]]>([
      ['users:manage', ['roles:manage', 'inventory:read']],
      ['roles:manage', ['users:manage', 'inventory:read']],
    ])(
      'refuses to drop %s from the only role governing an active user',
      async (_dropped, next) => {
        const governanceRoleId = await createRole([...GOVERNANCE, 'inventory:read']);
        const governor = await seedUser({ roleId: governanceRoleId });
        await seedUser({ roleId: await createRole(GOVERNANCE), status: 'BLOCKED' });
        await seedUser({ roleId: await createRole(GOVERNANCE), status: 'DELETED', deletedAt: new Date() });
        const before = await roleRow(governanceRoleId);

        const response = await updateRole(governanceRoleId, { permissions: next }, await tokenFor(governor.email)).expect(
          409,
        );

        expect(response.body).toEqual({
          statusCode: 409,
          code: 'LAST_ADMIN_PROTECTED',
          message: 'At least one active user must keep the users:manage and roles:manage permissions',
        } satisfies RoleError);
        expect(await roleRow(governanceRoleId)).toEqual(before);
      },
    );

    it('allows dropping governance from a role while another role governs an active user', async () => {
      const governanceRoleId = await createRole(GOVERNANCE);
      const governor = await seedUser({ roleId: governanceRoleId });
      await seedUser({ roleId: await createRole([...GOVERNANCE, 'dashboard:view']) });

      const response = await updateRole(
        governanceRoleId,
        { permissions: ['users:manage'] },
        await tokenFor(governor.email),
      ).expect(200);

      expect(roleSchema.parse(response.body).permissions).toEqual(['users:manage']);
      await listRoles(await tokenFor(governor.email)).expect(403);
    });

    it('allows renaming the only governing role', async () => {
      const governanceRoleId = await createRole(GOVERNANCE, 'Owners');
      const governor = await seedUser({ roleId: governanceRoleId });

      await updateRole(governanceRoleId, { name: 'Founders' }, await tokenFor(governor.email)).expect(200);

      expect(await roleRow(governanceRoleId)).toMatchObject({ name: 'Founders' });
    });
  });
});
