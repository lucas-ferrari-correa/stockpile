import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  ACCESS_REQUEST_ACCEPTED_MESSAGE,
  PERMISSIONS,
  Permission,
  UserError,
  UserStatus,
  authErrorSchema,
  loginResponseSchema,
  meResponseSchema,
  userErrorSchema,
  userListItemSchema,
  userPageSchema,
} from '@stockpile/shared';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { PASSWORD_HASHER, PasswordHasher } from '../src/modules/auth/ports/password-hasher.port';
import { UserAction } from '../src/modules/users/domain/user-lifecycle';
import { seedRoles } from '../src/seed/admin-seed';

const PASSWORD = 'user-password-0123';
const REQUESTED_PASSWORD = 'requested-password-0123';
const EARLIER_DELETION = new Date('2026-01-15T10:20:30.400Z');
const GOVERNANCE: readonly Permission[] = ['users:manage', 'roles:manage'];

interface ActionRoute {
  method: 'post' | 'patch' | 'delete';
  path: (id: string) => string;
  needsRole: boolean;
}

const ROUTES = {
  approve: { method: 'post', path: (id) => `/users/${id}/approve`, needsRole: true },
  reject: { method: 'post', path: (id) => `/users/${id}/reject`, needsRole: false },
  block: { method: 'post', path: (id) => `/users/${id}/block`, needsRole: false },
  unblock: { method: 'post', path: (id) => `/users/${id}/unblock`, needsRole: false },
  delete: { method: 'delete', path: (id) => `/users/${id}`, needsRole: false },
  changeRole: { method: 'patch', path: (id) => `/users/${id}/role`, needsRole: true },
} as const satisfies Record<UserAction, ActionRoute>;

const ACTIONS: readonly UserAction[] = ['approve', 'reject', 'block', 'unblock', 'delete', 'changeRole'];

const LIST_ITEM_KEYS = ['createdAt', 'deletedAt', 'email', 'id', 'name', 'reRequestOfDeleted', 'role', 'status'];

const ACCESS_REQUESTED_BODY = { code: 'ACCESS_REQUESTED', message: ACCESS_REQUEST_ACCEPTED_MESSAGE };

interface UserSeed {
  name?: string;
  status?: UserStatus;
  roleId?: string | null;
  createdAt?: Date;
  deletedAt?: Date | null;
}

interface SeededUser {
  id: string;
  email: string;
}

interface EventRow {
  type: string;
  actorId: string | null;
  reRegistration: boolean;
}

interface UserSnapshot {
  name: string;
  passwordHash: string;
  status: UserStatus;
  roleId: string | null;
  deletedAt: Date | null;
  updatedAt: Date;
}

describe('users', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let passwordHash: string;
  let viewerRoleId: string;

  async function createRole(permissions: readonly Permission[]): Promise<string> {
    const role = await prisma.role.create({
      data: {
        name: `custom-${randomUUID()}`,
        permissions: { createMany: { data: permissions.map((permission) => ({ permission })) } },
      },
      select: { id: true },
    });
    return role.id;
  }

  async function seedUser(seed: UserSeed = {}): Promise<SeededUser> {
    return prisma.user.create({
      data: {
        name: seed.name ?? 'Stock Keeper',
        email: `${randomUUID()}@example.test`,
        passwordHash,
        status: seed.status ?? 'ACTIVE',
        roleId: seed.roleId === undefined ? viewerRoleId : seed.roleId,
        createdAt: seed.createdAt,
        deletedAt: seed.deletedAt ?? null,
      },
      select: { id: true, email: true },
    });
  }

  async function seedGovernor(): Promise<SeededUser & { token: string }> {
    const user = await seedUser({ roleId: await createRole(GOVERNANCE) });
    return { ...user, token: await tokenFor(user.email) };
  }

  async function seedUserManager(): Promise<SeededUser & { token: string }> {
    const user = await seedUser({ roleId: await createRole(['users:manage']) });
    return { ...user, token: await tokenFor(user.email) };
  }

  function login(email: string, password: string = PASSWORD): request.Test {
    return request(app.getHttpServer()).post('/auth/login').send({ email, password });
  }

  async function tokenFor(email: string, password: string = PASSWORD): Promise<string> {
    const response = await login(email, password).expect(200);
    return loginResponseSchema.parse(response.body).accessToken;
  }

  function me(token: string): request.Test {
    return request(app.getHttpServer()).get('/auth/me').auth(token, { type: 'bearer' });
  }

  function requestAccess(email: string, password: string = REQUESTED_PASSWORD, name = 'Requester'): request.Test {
    return request(app.getHttpServer()).post('/auth/access-requests').send({ name, email, password });
  }

  function act(action: UserAction, id: string, token?: string, roleId: string = viewerRoleId): request.Test {
    const route: ActionRoute = ROUTES[action];
    const pending = request(app.getHttpServer())[route.method](route.path(id));
    const withBody = route.needsRole ? pending.send({ roleId }) : pending;
    return token === undefined ? withBody : withBody.auth(token, { type: 'bearer' });
  }

  function listUsers(token?: string, query: Record<string, string | number> = {}): request.Test {
    const pending = request(app.getHttpServer()).get('/users').query(query);
    return token === undefined ? pending : pending.auth(token, { type: 'bearer' });
  }

  function errorCode(body: unknown): string {
    return authErrorSchema.parse(body).code;
  }

  function userErrorCode(body: unknown): string {
    return userErrorSchema.parse(body).code;
  }

  async function eventsOf(userId: string): Promise<EventRow[]> {
    return prisma.userEvent.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: { type: true, actorId: true, reRegistration: true },
    });
  }

  async function snapshotOf(userId: string): Promise<UserSnapshot> {
    return prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { name: true, passwordHash: true, status: true, roleId: true, deletedAt: true, updatedAt: true },
    });
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
    ({ viewerRoleId } = await seedRoles(prisma));
  });

  afterAll(async () => {
    await app.close();
  });

  describe('access requests', () => {
    it('lets a new requester sign in with the role chosen at approval', async () => {
      const governor = await seedGovernor();
      const chosenRoleId = await createRole(['inventory:read', 'imports:manage']);

      const response = await requestAccess('New.Person@Example.test').expect(202);

      expect(response.body).toEqual(ACCESS_REQUESTED_BODY);
      const created = await prisma.user.findUniqueOrThrow({
        where: { email: 'new.person@example.test' },
        select: { id: true, status: true, roleId: true, deletedAt: true },
      });
      expect(created).toMatchObject({ status: 'PENDING', roleId: null, deletedAt: null });
      const pendingLogin = await login('new.person@example.test', REQUESTED_PASSWORD).expect(403);
      expect(errorCode(pendingLogin.body)).toBe('ACCOUNT_PENDING');

      const approved = await act('approve', created.id, governor.token, chosenRoleId).expect(200);

      expect(userListItemSchema.parse(approved.body)).toMatchObject({
        id: created.id,
        status: 'ACTIVE',
        role: { id: chosenRoleId },
        deletedAt: null,
      });
      const session = await me(await tokenFor('new.person@example.test', REQUESTED_PASSWORD)).expect(200);
      const profile = meResponseSchema.parse(session.body);
      expect(profile.role.id).toBe(chosenRoleId);
      expect([...profile.permissions].sort()).toEqual(['imports:manage', 'inventory:read']);
      expect(await eventsOf(created.id)).toEqual([
        { type: 'REQUESTED', actorId: null, reRegistration: false },
        { type: 'APPROVED', actorId: governor.id, reRegistration: false },
      ]);
    });

    it('answers a repeated request from a pending requester like the first and creates no second user', async () => {
      const first = await requestAccess('twice@example.test').expect(202);
      const { id } = await prisma.user.findUniqueOrThrow({
        where: { email: 'twice@example.test' },
        select: { id: true },
      });
      const before = await snapshotOf(id);

      const repeated = await requestAccess(' TWICE@example.test ', 'another-password-0123', 'Intruder');

      expect(repeated.status).toBe(first.status);
      expect(repeated.text).toBe(first.text);
      expect(await prisma.user.count()).toBe(1);
      expect(await snapshotOf(id)).toEqual(before);
      expect(await eventsOf(id)).toEqual([{ type: 'REQUESTED', actorId: null, reRegistration: false }]);
    });

    it('answers a request for an active account exactly like a new one and leaves it untouched', async () => {
      const existing = await seedUser({ name: 'Original' });
      const before = await snapshotOf(existing.id);

      const fresh = await requestAccess('fresh@example.test');
      const repeated = await requestAccess(existing.email.toUpperCase(), 'another-password-0123', 'Intruder');

      expect(repeated.status).toBe(202);
      expect(repeated.status).toBe(fresh.status);
      expect(repeated.text).toBe(fresh.text);
      expect(await snapshotOf(existing.id)).toEqual(before);
      expect(await eventsOf(existing.id)).toEqual([]);
    });

    it('answers deleted, re-registering, blocked and rejected accounts with the same 403', async () => {
      const deleted = await seedUser({ status: 'DELETED', deletedAt: EARLIER_DELETION });
      const reRegistering = await seedUser({ status: 'PENDING', roleId: null, deletedAt: EARLIER_DELETION });
      const blocked = await seedUser({ status: 'BLOCKED' });
      const rejected = await seedUser({ status: 'REJECTED', roleId: null });
      const untouched = [reRegistering, blocked, rejected];
      const before = await Promise.all(untouched.map((user) => snapshotOf(user.id)));

      const responses: request.Response[] = [];
      for (const user of [deleted, reRegistering, blocked, rejected]) {
        responses.push(await requestAccess(user.email, 'another-password-0123', 'Intruder'));
      }

      expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403]);
      expect(errorCode(responses[0]?.body)).toBe('ACCOUNT_UNAVAILABLE');
      expect(new Set(responses.map((response) => response.text)).size).toBe(1);
      expect(await Promise.all(untouched.map((user) => snapshotOf(user.id)))).toEqual(before);
      for (const user of untouched) {
        expect(await eventsOf(user.id)).toEqual([]);
      }
    });

    it('turns a deleted account into a flagged pending request without a role until approved', async () => {
      const governor = await seedGovernor();
      const user = await seedUser({ name: 'Old Name' });
      await act('delete', user.id, governor.token).expect(200);
      const { deletedAt } = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { deletedAt: true } });

      const response = await requestAccess(user.email, REQUESTED_PASSWORD, 'New Name').expect(403);

      expect(errorCode(response.body)).toBe('ACCOUNT_UNAVAILABLE');
      const reopened = await snapshotOf(user.id);
      expect(reopened).toMatchObject({ name: 'New Name', status: 'PENDING', roleId: null, deletedAt });
      expect(reopened.deletedAt).not.toBeNull();
      expect(reopened.passwordHash).not.toBe(passwordHash);
      await login(user.email, REQUESTED_PASSWORD).expect(401);
      const listing = await listUsers(governor.token, { status: 'PENDING' }).expect(200);
      expect(userPageSchema.parse(listing.body).items).toEqual([
        expect.objectContaining({
          id: user.id,
          role: null,
          deletedAt: deletedAt?.toISOString(),
          reRequestOfDeleted: true,
        }),
      ]);

      const approved = await act('approve', user.id, governor.token).expect(200);

      expect(userListItemSchema.parse(approved.body)).toMatchObject({
        status: 'ACTIVE',
        role: { id: viewerRoleId },
        deletedAt: null,
        reRequestOfDeleted: false,
      });
      await me(await tokenFor(user.email, REQUESTED_PASSWORD)).expect(200);
      expect(await eventsOf(user.id)).toEqual([
        { type: 'DELETED', actorId: governor.id, reRegistration: false },
        { type: 'REQUESTED', actorId: null, reRegistration: true },
        { type: 'APPROVED', actorId: governor.id, reRegistration: false },
      ]);
    });

    it('clears the deletion mark when a re-registration is rejected and refuses later requests', async () => {
      const governor = await seedGovernor();
      const user = await seedUser({ status: 'DELETED', deletedAt: EARLIER_DELETION });
      await requestAccess(user.email).expect(403);

      const rejected = await act('reject', user.id, governor.token).expect(200);

      expect(userListItemSchema.parse(rejected.body)).toMatchObject({
        status: 'REJECTED',
        deletedAt: null,
        reRequestOfDeleted: false,
      });
      const before = await snapshotOf(user.id);
      await requestAccess(user.email, 'another-password-0123').expect(403);
      expect(await snapshotOf(user.id)).toEqual(before);
      expect(await eventsOf(user.id)).toEqual([
        { type: 'REQUESTED', actorId: null, reRegistration: true },
        { type: 'REJECTED', actorId: governor.id, reRegistration: false },
      ]);
    });

    it('rejects a malformed request without creating anyone', async () => {
      await request(app.getHttpServer())
        .post('/auth/access-requests')
        .send({ name: '', email: 'not-an-email', password: 'short' })
        .expect(400);

      expect(await prisma.user.count()).toBe(0);
    });
  });

  describe('approval and role assignment', () => {
    it.each<[string, object]>([
      ['no roleId', {}],
      ['a roleId that is not a uuid', { roleId: 'viewer' }],
    ])('answers 400 to an approval with %s and keeps the request pending', async (_label, body) => {
      const governor = await seedGovernor();
      const pending = await seedUser({ status: 'PENDING', roleId: null });

      await request(app.getHttpServer())
        .post(`/users/${pending.id}/approve`)
        .auth(governor.token, { type: 'bearer' })
        .send(body)
        .expect(400);

      expect(await snapshotOf(pending.id)).toMatchObject({ status: 'PENDING', roleId: null });
      expect(await eventsOf(pending.id)).toEqual([]);
    });

    it.each<[UserAction, UserStatus]>([
      ['approve', 'PENDING'],
      ['changeRole', 'ACTIVE'],
    ])('answers 422 to %s with a role that does not exist and changes nothing', async (action, status) => {
      const governor = await seedGovernor();
      const target = await seedUser({ status, roleId: status === 'PENDING' ? null : viewerRoleId });
      const before = await snapshotOf(target.id);

      const response = await act(action, target.id, governor.token, randomUUID()).expect(422);

      expect(response.body).toEqual({
        statusCode: 422,
        code: 'ROLE_NOT_FOUND',
        message: 'The selected role does not exist',
      } satisfies UserError);
      expect(await snapshotOf(target.id)).toEqual(before);
      expect(await eventsOf(target.id)).toEqual([]);
    });

    it('applies a role change on the next request made with the same token', async () => {
      const governor = await seedGovernor();
      const user = await seedUser();
      const token = await tokenFor(user.email);
      await listUsers(token).expect(403);
      const managerRoleId = await createRole(['users:manage', 'inventory:read']);

      const promoted = await act('changeRole', user.id, governor.token, managerRoleId).expect(200);

      expect(userListItemSchema.parse(promoted.body)).toMatchObject({ status: 'ACTIVE', role: { id: managerRoleId } });
      await listUsers(token).expect(200);

      await act('changeRole', user.id, governor.token, viewerRoleId).expect(200);

      const denied = await listUsers(token).expect(403);
      expect(errorCode(denied.body)).toBe('ACCESS_DENIED');
      expect(await eventsOf(user.id)).toEqual([
        { type: 'ROLE_CHANGED', actorId: governor.id, reRegistration: false },
        { type: 'ROLE_CHANGED', actorId: governor.id, reRegistration: false },
      ]);
    });

    it('lets a user manager change their own role, applying it on the next request', async () => {
      const manager = await seedUserManager();

      const response = await act('changeRole', manager.id, manager.token, viewerRoleId).expect(200);

      expect(userListItemSchema.parse(response.body)).toMatchObject({ id: manager.id, role: { id: viewerRoleId } });
      const denied = await listUsers(manager.token).expect(403);
      expect(errorCode(denied.body)).toBe('ACCESS_DENIED');
      expect(await eventsOf(manager.id)).toEqual([{ type: 'ROLE_CHANGED', actorId: manager.id, reRegistration: false }]);
    });

    it.each<[string, boolean]>([
      ['another user', false],
      ['the own account', true],
    ])('answers a change to the current role of %s with 200 and changes nothing', async (_label, self) => {
      const governor = await seedGovernor();
      const target = self ? governor : await seedUser();
      const before = await snapshotOf(target.id);

      const response = await act('changeRole', target.id, governor.token, before.roleId ?? '').expect(200);

      expect(userListItemSchema.parse(response.body)).toMatchObject({ id: target.id, role: { id: before.roleId } });
      expect(await snapshotOf(target.id)).toEqual(before);
      expect(await eventsOf(target.id)).toEqual([]);
    });

    it('changes the role of a blocked user without unblocking them', async () => {
      const governor = await seedGovernor();
      const user = await seedUser({ status: 'BLOCKED' });
      const otherRoleId = await createRole(['inventory:read']);

      const response = await act('changeRole', user.id, governor.token, otherRoleId).expect(200);

      expect(userListItemSchema.parse(response.body)).toMatchObject({ status: 'BLOCKED', role: { id: otherRoleId } });
    });
  });

  describe('status actions', () => {
    it('cuts a blocked user off on the next request and restores access once unblocked', async () => {
      const governor = await seedGovernor();
      const user = await seedUser();
      const token = await tokenFor(user.email);
      await me(token).expect(200);

      const blocked = await act('block', user.id, governor.token).expect(200);

      expect(userListItemSchema.parse(blocked.body)).toMatchObject({ id: user.id, status: 'BLOCKED' });
      const denied = await me(token).expect(403);
      expect(errorCode(denied.body)).toBe('ACCOUNT_BLOCKED');
      const blockedLogin = await login(user.email).expect(403);
      expect(errorCode(blockedLogin.body)).toBe('ACCOUNT_BLOCKED');

      const unblocked = await act('unblock', user.id, governor.token).expect(200);

      expect(userListItemSchema.parse(unblocked.body)).toMatchObject({
        id: user.id,
        status: 'ACTIVE',
        role: { id: viewerRoleId },
      });
      await me(token).expect(200);
      expect(await eventsOf(user.id)).toEqual([
        { type: 'BLOCKED', actorId: governor.id, reRegistration: false },
        { type: 'APPROVED', actorId: governor.id, reRegistration: false },
      ]);
    });

    it('rejects a pending request so the requester cannot sign in', async () => {
      const governor = await seedGovernor();
      const pending = await seedUser({ status: 'PENDING', roleId: null });

      const response = await act('reject', pending.id, governor.token).expect(200);

      expect(userListItemSchema.parse(response.body)).toMatchObject({ id: pending.id, status: 'REJECTED', role: null });
      await login(pending.email).expect(401);
      expect(await eventsOf(pending.id)).toEqual([{ type: 'REJECTED', actorId: governor.id, reRegistration: false }]);
    });

    it('soft deletes a user, keeping the row and revoking the issued token', async () => {
      const governor = await seedGovernor();
      const user = await seedUser();
      const token = await tokenFor(user.email);

      const response = await act('delete', user.id, governor.token).expect(200);

      const body = userListItemSchema.parse(response.body);
      expect(body).toMatchObject({ id: user.id, status: 'DELETED', reRequestOfDeleted: false });
      const row = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
        select: { status: true, deletedAt: true },
      });
      expect(row.status).toBe('DELETED');
      expect(row.deletedAt?.toISOString()).toBe(body.deletedAt);
      const denied = await me(token).expect(401);
      expect(errorCode(denied.body)).toBe('UNAUTHENTICATED');
      expect(await eventsOf(user.id)).toEqual([{ type: 'DELETED', actorId: governor.id, reRegistration: false }]);
    });

    it('replaces an earlier deletion date when a re-registration is deleted again', async () => {
      const governor = await seedGovernor();
      const user = await seedUser({ status: 'PENDING', roleId: null, deletedAt: EARLIER_DELETION });

      const response = await act('delete', user.id, governor.token).expect(200);

      const body = userListItemSchema.parse(response.body);
      expect(body.status).toBe('DELETED');
      expect(new Date(body.deletedAt ?? 0).getTime()).toBeGreaterThan(EARLIER_DELETION.getTime());
    });

    it.each<[UserAction, UserStatus]>([
      ['approve', 'ACTIVE'],
      ['reject', 'BLOCKED'],
      ['block', 'PENDING'],
      ['unblock', 'ACTIVE'],
      ['delete', 'DELETED'],
      ['changeRole', 'PENDING'],
    ])('answers 409 to %s on a %s user and changes nothing', async (action, status) => {
      const governor = await seedGovernor();
      const target = await seedUser({ status, deletedAt: status === 'DELETED' ? EARLIER_DELETION : null });
      const before = await snapshotOf(target.id);

      const response = await act(action, target.id, governor.token, await createRole(['inventory:read'])).expect(409);

      expect(response.body).toEqual({
        statusCode: 409,
        code: 'INVALID_TRANSITION',
        message: 'This action is not allowed for the current status of the user',
      } satisfies UserError);
      expect(await snapshotOf(target.id)).toEqual(before);
      expect(await eventsOf(target.id)).toEqual([]);
    });

    it.each(ACTIONS.filter((action) => action !== 'changeRole'))('forbids running %s on the own account', async (action) => {
      const governor = await seedGovernor();
      const before = await snapshotOf(governor.id);

      const response = await act(action, governor.id, governor.token).expect(409);

      expect(userErrorCode(response.body)).toBe('SELF_ACTION_FORBIDDEN');
      expect(await snapshotOf(governor.id)).toEqual(before);
      expect(await eventsOf(governor.id)).toEqual([]);
    });

    it.each(ACTIONS)('answers 404 to %s on an unknown id', async (action) => {
      const governor = await seedGovernor();

      const response = await act(action, randomUUID(), governor.token).expect(404);

      expect(response.body).toEqual({
        statusCode: 404,
        code: 'USER_NOT_FOUND',
        message: 'User not found',
      } satisfies UserError);
    });

    it.each(ACTIONS)('answers 400 to %s when the id is not a uuid', async (action) => {
      const governor = await seedGovernor();

      await act(action, 'not-a-uuid', governor.token).expect(400);
    });
  });

  describe('last governor protection', () => {
    it.each<[UserAction, Permission[]]>([
      ['block', []],
      ['delete', []],
      ['changeRole', ['users:manage', 'inventory:write']],
      ['changeRole', ['roles:manage']],
    ])(
      'refuses to %s the only active user holding users:manage and roles:manage (next role %j)',
      async (action, nextPermissions) => {
        const manager = await seedUserManager();
        const lastGovernor = await seedUser({ roleId: await createRole(PERMISSIONS) });
        await seedUser({ status: 'BLOCKED', roleId: await createRole(GOVERNANCE) });
        const before = await snapshotOf(lastGovernor.id);

        const response = await act(action, lastGovernor.id, manager.token, await createRole(nextPermissions)).expect(409);

        expect(response.body).toEqual({
          statusCode: 409,
          code: 'LAST_ADMIN_PROTECTED',
          message: 'At least one active user must keep the users:manage and roles:manage permissions',
        } satisfies UserError);
        expect(await snapshotOf(lastGovernor.id)).toEqual(before);
        expect(await eventsOf(lastGovernor.id)).toEqual([]);
      },
    );

    it('refuses the only governor a change of their own role to one without both permissions', async () => {
      const governor = await seedGovernor();
      const before = await snapshotOf(governor.id);

      const response = await act('changeRole', governor.id, governor.token, await createRole(['users:manage'])).expect(409);

      expect(userErrorCode(response.body)).toBe('LAST_ADMIN_PROTECTED');
      expect(await snapshotOf(governor.id)).toEqual(before);
      expect(await eventsOf(governor.id)).toEqual([]);
      await listUsers(governor.token).expect(200);
    });

    it.each<UserAction>(['block', 'delete', 'changeRole'])(
      'allows %s on a governor while another active governor remains',
      async (action) => {
        const governor = await seedGovernor();
        const otherGovernor = await seedUser({ roleId: await createRole(GOVERNANCE) });

        await act(action, otherGovernor.id, governor.token).expect(200);

        expect(await eventsOf(otherGovernor.id)).toHaveLength(1);
      },
    );

    it('allows moving the only governor to another role that also holds both permissions', async () => {
      const manager = await seedUserManager();
      const lastGovernor = await seedUser({ roleId: await createRole(GOVERNANCE) });
      const nextRoleId = await createRole([...GOVERNANCE, 'inventory:read']);

      const response = await act('changeRole', lastGovernor.id, manager.token, nextRoleId).expect(200);

      expect(userListItemSchema.parse(response.body).role?.id).toBe(nextRoleId);
    });

    it('keeps one active governor when two governors block each other at the same time', async () => {
      const first = await seedGovernor();
      const second = await seedGovernor();

      const responses = await Promise.all([act('block', second.id, first.token), act('block', first.id, second.token)]);

      const statuses = responses.map((response) => response.status).sort();
      expect(statuses[0]).toBe(200);
      expect([403, 409]).toContain(statuses[1]);
      expect(await prisma.user.count({ where: { status: 'ACTIVE' } })).toBe(1);
    });
  });

  describe('access control', () => {
    const ROUTE_CASES: ReadonlyArray<[string, (id: string, token?: string) => request.Test]> = [
      ['list', (_id, token) => listUsers(token)],
      ...ACTIONS.map((action): [string, (id: string, token?: string) => request.Test] => [
        action,
        (id, token) => act(action, id, token),
      ]),
    ];

    it.each(ROUTE_CASES)(
      'answers %s with 401 without a token and 403 for a role holding every permission but users:manage',
      async (_name, call) => {
        const target = await seedUser({ status: 'PENDING', roleId: null });
        const caller = await seedUser({
          roleId: await createRole(PERMISSIONS.filter((permission) => permission !== 'users:manage')),
        });
        const token = await tokenFor(caller.email);

        const anonymous = await call(target.id).expect(401);
        const forbidden = await call(target.id, token).expect(403);

        expect(errorCode(anonymous.body)).toBe('UNAUTHENTICATED');
        expect(errorCode(forbidden.body)).toBe('ACCESS_DENIED');
        expect(await snapshotOf(target.id)).toMatchObject({ status: 'PENDING', roleId: null });
        expect(await eventsOf(target.id)).toEqual([]);
      },
    );
  });

  describe('listing', () => {
    it('pages newest first without repeating or skipping users, even when creation times tie', async () => {
      const governor = await seedUser({
        roleId: await createRole(GOVERNANCE),
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      const token = await tokenFor(governor.email);
      const tied = new Date('2026-03-01T00:00:00.000Z');
      await seedUser({ createdAt: new Date('2026-04-01T00:00:00.000Z') });
      await seedUser({ createdAt: tied });
      await seedUser({ createdAt: tied });
      await seedUser({ createdAt: tied });
      await seedUser({ createdAt: new Date('2026-02-01T00:00:00.000Z') });
      const expected = await prisma.user.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      });

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query: Record<string, string | number> = cursor === null ? { limit: 2 } : { limit: 2, cursor };
        const response = await listUsers(token, query).expect(200);
        const page = userPageSchema.parse(response.body);
        expect(page.items.length).toBeLessThanOrEqual(2);
        for (const item of page.items) {
          expect(Object.keys(item).sort()).toEqual(LIST_ITEM_KEYS);
        }
        seen.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
        pages++;
      } while (cursor !== null && pages < 10);

      expect(pages).toBe(3);
      expect(seen).toEqual(expected.map((user) => user.id));
      expect(seen.at(-1)).toBe(governor.id);
    });

    it('filters by status and paginates within the filter', async () => {
      const governor = await seedGovernor();
      const pendingIds = [
        (await seedUser({ status: 'PENDING', roleId: null })).id,
        (await seedUser({ status: 'PENDING', roleId: null })).id,
        (await seedUser({ status: 'PENDING', roleId: null, deletedAt: EARLIER_DELETION })).id,
      ];
      await seedUser({ status: 'BLOCKED' });
      await seedUser({ status: 'DELETED', deletedAt: new Date() });

      const firstResponse = await listUsers(governor.token, { status: 'PENDING', limit: 2 }).expect(200);
      const first = userPageSchema.parse(firstResponse.body);
      const secondResponse = await listUsers(governor.token, {
        status: 'PENDING',
        limit: 2,
        cursor: first.nextCursor ?? '',
      }).expect(200);
      const second = userPageSchema.parse(secondResponse.body);

      const items = [...first.items, ...second.items];
      expect(items.every((item) => item.status === 'PENDING' && item.role === null)).toBe(true);
      expect(items.map((item) => item.id).sort()).toEqual([...pendingIds].sort());
      expect(items.filter((item) => item.reRequestOfDeleted).map((item) => item.id)).toEqual([pendingIds[2]]);
      expect(second.nextCursor).toBeNull();
      const deletedResponse = await listUsers(governor.token, { status: 'DELETED' }).expect(200);
      const deleted = userPageSchema.parse(deletedResponse.body);
      expect(deleted.items).toHaveLength(1);
      expect(deleted.items[0]?.reRequestOfDeleted).toBe(false);
    });

    it('rejects a well formed cursor that matches no user', async () => {
      const governor = await seedGovernor();

      const response = await listUsers(governor.token, { cursor: randomUUID() }).expect(400);

      expect(response.body).toEqual({
        statusCode: 400,
        code: 'INVALID_CURSOR',
        message: 'The cursor does not match any user',
      } satisfies UserError);
    });

    it.each<Record<string, string | number>>([{ status: 'UNKNOWN' }, { limit: 0 }, { limit: 101 }, { cursor: 'nope' }])(
      'rejects the query %o',
      async (query) => {
        const governor = await seedGovernor();

        await listUsers(governor.token, query).expect(400);
      },
    );
  });
});
