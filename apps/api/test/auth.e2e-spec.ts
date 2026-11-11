import { randomUUID } from 'node:crypto';
import { Controller, Get, INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import {
  PERMISSIONS,
  Permission,
  UserStatus,
  authErrorSchema,
  loginResponseSchema,
  meResponseSchema,
  userPageSchema,
} from '@stockpile/shared';
import Redis from 'ioredis';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { REDIS } from '../src/infra/redis/redis.constants';
import { RequirePermissions } from '../src/modules/auth/adapters/http/auth.decorators';
import { PASSWORD_HASHER, PasswordHasher } from '../src/modules/auth/ports/password-hasher.port';
import { seedRoles } from '../src/seed/admin-seed';

const PASSWORD = 'correct-horse-battery';

@Controller('probe')
class ProbeController {
  @Get('write')
  @RequirePermissions('inventory:write')
  write(): { ok: true } {
    return { ok: true };
  }
}

type RateLimitEnv = Partial<
  Record<'THROTTLE_LOGIN_LIMIT' | 'THROTTLE_LOGIN_TTL_MS' | 'THROTTLE_ACCESS_REQUEST_LIMIT' | 'TRUST_PROXY_HOPS', string>
>;

async function createAppWith(overrides: RateLimitEnv): Promise<INestApplication<App>> {
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const created = moduleRef.createNestApplication<INestApplication<App>>();
    configureApp(created);
    await created.init();
    return created;
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function clearThrottleKeys(redis: Redis): Promise<void> {
  const keys: string[] = [];
  for await (const batch of redis.scanStream({ match: '{throttle:*', count: 100 }) as AsyncIterable<string[]>) {
    keys.push(...batch);
  }
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

interface UserInput {
  status?: UserStatus;
  roleId?: string;
}

interface CredentialsRow {
  name: string;
  email: string;
  passwordHash: string;
  sessionVersion: number;
  status: UserStatus;
  deletedAt: Date | null;
  roleId: string | null;
}

describe('auth', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let jwt: JwtService;
  let passwordHash: string;
  let roles: { adminRoleId: string; viewerRoleId: string };

  async function createUser(input: UserInput = {}): Promise<{ id: string; email: string }> {
    return prisma.user.create({
      data: {
        name: 'Stock Keeper',
        email: `${randomUUID()}@example.test`,
        passwordHash,
        status: input.status ?? 'ACTIVE',
        roleId: input.roleId ?? roles.viewerRoleId,
      },
      select: { id: true, email: true },
    });
  }

  async function createRole(permissions: Permission[]): Promise<string> {
    const role = await prisma.role.create({
      data: { name: `custom-${randomUUID()}`, permissions: { createMany: { data: permissions.map((permission) => ({ permission })) } } },
      select: { id: true },
    });
    return role.id;
  }

  async function tokenFor(email: string, password: string = PASSWORD): Promise<string> {
    const response = await request(app.getHttpServer()).post('/auth/login').send({ email, password }).expect(200);
    return loginResponseSchema.parse(response.body).accessToken;
  }

  function errorCode(body: unknown): string {
    return authErrorSchema.parse(body).code;
  }

  function credentialsRow(id: string): Promise<CredentialsRow> {
    return prisma.user.findUniqueOrThrow({
      where: { id },
      select: { name: true, email: true, passwordHash: true, sessionVersion: true, status: true, deletedAt: true, roleId: true },
    });
  }

  function updateProfile(token: string | undefined, body: object): request.Test {
    const pending = request(app.getHttpServer()).patch('/auth/me').send(body);
    return token === undefined ? pending : pending.auth(token, { type: 'bearer' });
  }

  function changePassword(token: string | undefined, body: object): request.Test {
    const pending = request(app.getHttpServer()).post('/auth/me/password').send(body);
    return token === undefined ? pending : pending.auth(token, { type: 'bearer' });
  }

  function login(email: string, password: string): request.Test {
    return request(app.getHttpServer()).post('/auth/login').send({ email, password });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule], controllers: [ProbeController] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    passwordHash = await app.get<PasswordHasher>(PASSWORD_HASHER).hash(PASSWORD);
  });

  beforeEach(async () => {
    await prisma.user.deleteMany();
    await prisma.role.deleteMany();
    roles = await seedRoles(prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('login', () => {
    it('returns a bearer token that authenticates /auth/me with role and permissions', async () => {
      const user = await createUser();

      const token = await tokenFor(user.email);
      const response = await request(app.getHttpServer()).get('/auth/me').auth(token, { type: 'bearer' }).expect(200);

      const me = meResponseSchema.parse(response.body);
      expect(me).toMatchObject({ id: user.id, email: user.email, status: 'ACTIVE', role: { id: roles.viewerRoleId, name: 'viewer' } });
      expect([...me.permissions].sort()).toEqual(['dashboard:view', 'inventory:read']);
    });

    it('accepts the email regardless of letter case and surrounding spaces', async () => {
      const user = await createUser();

      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: `  ${user.email.toUpperCase()} `, password: PASSWORD })
        .expect(200);
    });

    it('answers a wrong password and an unknown email with the same 401 response', async () => {
      const user = await createUser();

      const wrongPassword = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: user.email, password: 'wrong-password' })
        .expect(401);
      const unknownEmail = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'nobody@example.test', password: PASSWORD })
        .expect(401);

      expect(errorCode(wrongPassword.body)).toBe('INVALID_CREDENTIALS');
      expect(unknownEmail.body).toEqual(wrongPassword.body);
    });

    it.each<[UserStatus, string]>([
      ['PENDING', 'ACCOUNT_PENDING'],
      ['BLOCKED', 'ACCOUNT_BLOCKED'],
    ])('rejects a %s user with the right password with 403 %s', async (status, code) => {
      const user = await createUser({ status });

      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: user.email, password: PASSWORD })
        .expect(403);

      expect(errorCode(response.body)).toBe(code);
    });

    it('rejects a malformed body with 400 before checking credentials', async () => {
      await request(app.getHttpServer()).post('/auth/login').send({ email: 'not-an-email', password: '' }).expect(400);
    });
  });

  describe('bearer token', () => {
    it.each<[string, (userId: string) => Promise<string | undefined>]>([
      ['missing', () => Promise.resolve(undefined)],
      ['malformed', () => Promise.resolve('not-a-jwt')],
      ['signed with another secret', (sub) => jwt.signAsync({ sub, sv: 0 }, { secret: 'another-secret-with-at-least-32-characters' })],
      ['expired', (sub) => jwt.signAsync({ sub, sv: 0 }, { expiresIn: -60 })],
      ['carrying a non uuid subject', () => jwt.signAsync({ sub: 'admin', sv: 0 })],
      ['missing the session version', (sub) => jwt.signAsync({ sub })],
    ])('denies a protected route with 401 when the token is %s', async (_label, makeToken) => {
      const user = await createUser();
      const token = await makeToken(user.id);

      const call = request(app.getHttpServer()).get('/auth/me');
      const response = await (token === undefined ? call : call.auth(token, { type: 'bearer' })).expect(401);

      expect(errorCode(response.body)).toBe('UNAUTHENTICATED');
    });

    it('denies a token issued before the user was blocked with 403 account blocked', async () => {
      const user = await createUser();
      const token = await tokenFor(user.email);

      await prisma.user.update({ where: { id: user.id }, data: { status: 'BLOCKED' }, select: { id: true } });
      const response = await request(app.getHttpServer()).get('/auth/me').auth(token, { type: 'bearer' }).expect(403);

      expect(errorCode(response.body)).toBe('ACCOUNT_BLOCKED');
    });

    it('denies a token issued before the user was soft deleted with 401', async () => {
      const user = await createUser();
      const token = await tokenFor(user.email);

      await prisma.user.update({
        where: { id: user.id },
        data: { status: 'DELETED', deletedAt: new Date() },
        select: { id: true },
      });
      const response = await request(app.getHttpServer()).get('/auth/me').auth(token, { type: 'bearer' }).expect(401);

      expect(errorCode(response.body)).toBe('UNAUTHENTICATED');
    });
  });

  describe('permissions', () => {
    it('denies a token issued before the role was removed from the user with 401', async () => {
      const user = await createUser();
      const token = await tokenFor(user.email);

      await prisma.user.update({ where: { id: user.id }, data: { roleId: null }, select: { id: true } });
      const response = await request(app.getHttpServer()).get('/auth/me').auth(token, { type: 'bearer' }).expect(401);

      expect(errorCode(response.body)).toBe('UNAUTHENTICATED');
    });

    it('denies a route whose permission the role lacks with 403 access denied', async () => {
      const user = await createUser();
      const token = await tokenFor(user.email);

      const response = await request(app.getHttpServer()).get('/probe/write').auth(token, { type: 'bearer' }).expect(403);

      expect(errorCode(response.body)).toBe('ACCESS_DENIED');
    });

    it('allows the seeded admin role on a permission protected route', async () => {
      const user = await createUser({ roleId: roles.adminRoleId });
      const token = await tokenFor(user.email);

      await request(app.getHttpServer()).get('/probe/write').auth(token, { type: 'bearer' }).expect(200, { ok: true });
    });

    it('applies a permission granted to or revoked from the role on the next request with the same token', async () => {
      const roleId = await createRole(['inventory:read']);
      const user = await createUser({ roleId });
      const token = await tokenFor(user.email);

      await request(app.getHttpServer()).get('/probe/write').auth(token, { type: 'bearer' }).expect(403);

      await prisma.rolePermission.create({ data: { roleId, permission: 'inventory:write' }, select: { roleId: true } });
      await request(app.getHttpServer()).get('/probe/write').auth(token, { type: 'bearer' }).expect(200);

      await prisma.rolePermission.delete({
        where: { roleId_permission: { roleId, permission: 'inventory:write' } },
        select: { roleId: true },
      });
      await request(app.getHttpServer()).get('/probe/write').auth(token, { type: 'bearer' }).expect(403);
    });
  });

  describe('self service profile', () => {
    const NEW_PASSWORD = 'tr0ub4dor-and-3';

    it('trims the new name and reflects it on /auth/me and on the user listing', async () => {
      const user = await createUser();
      const token = await tokenFor(user.email);
      const governor = await createUser({ roleId: roles.adminRoleId });
      const governorToken = await tokenFor(governor.email);

      const response = await updateProfile(token, { name: '  Renamed Keeper  ' }).expect(200);

      const me = await request(app.getHttpServer()).get('/auth/me').auth(token, { type: 'bearer' }).expect(200);
      expect(meResponseSchema.parse(response.body)).toEqual(meResponseSchema.parse(me.body));
      expect(me.body).toMatchObject({ id: user.id, name: 'Renamed Keeper', role: { id: roles.viewerRoleId } });
      const listing = await request(app.getHttpServer()).get('/users').auth(governorToken, { type: 'bearer' }).expect(200);
      expect(userPageSchema.parse(listing.body).items).toContainEqual(expect.objectContaining({ id: user.id, name: 'Renamed Keeper' }));
    });

    it('accepts a name at the maximum length', async () => {
      const user = await createUser();
      const name = 'n'.repeat(120);

      await updateProfile(await tokenFor(user.email), { name }).expect(200);

      expect(await credentialsRow(user.id)).toMatchObject({ name });
    });

    it.each<[string, object]>([
      ['missing', {}],
      ['empty', { name: '' }],
      ['only spaces', { name: '   ' }],
      ['longer than 120 characters', { name: 'n'.repeat(121) }],
      ['not a string', { name: 42 }],
    ])('rejects a name that is %s with 400 and keeps the stored name', async (_label, body) => {
      const user = await createUser();

      await updateProfile(await tokenFor(user.email), body).expect(400);

      expect(await credentialsRow(user.id)).toMatchObject({ name: 'Stock Keeper' });
    });

    it('ignores role, status, email, deletion and session fields sent along with the name', async () => {
      const user = await createUser();
      const token = await tokenFor(user.email);
      const before = await credentialsRow(user.id);

      const response = await updateProfile(token, {
        name: 'Renamed Keeper',
        roleId: roles.adminRoleId,
        status: 'BLOCKED',
        email: 'taken-over@example.test',
        deletedAt: new Date().toISOString(),
        sessionVersion: 99,
        passwordHash: 'forged',
      }).expect(200);

      expect(await credentialsRow(user.id)).toEqual({ ...before, name: 'Renamed Keeper' });
      expect(meResponseSchema.parse(response.body)).toMatchObject({
        email: user.email,
        status: 'ACTIVE',
        role: { id: roles.viewerRoleId, name: 'viewer' },
      });
      await request(app.getHttpServer()).get('/auth/me').auth(token, { type: 'bearer' }).expect(200);
    });

    it('lets a role without user or role governance rename itself and change its own password', async () => {
      const roleId = await createRole(PERMISSIONS.filter((permission) => permission !== 'users:manage' && permission !== 'roles:manage'));
      const user = await createUser({ roleId });
      const token = await tokenFor(user.email);
      await request(app.getHttpServer()).get('/users').auth(token, { type: 'bearer' }).expect(403);

      await updateProfile(token, { name: 'Self Served' }).expect(200);
      await changePassword(token, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(204);

      expect(await credentialsRow(user.id)).toMatchObject({ name: 'Self Served', roleId, sessionVersion: 1 });
      await login(user.email, NEW_PASSWORD).expect(200);
    });

    it('refuses a wrong current password with 403 and changes nothing', async () => {
      const user = await createUser();
      const token = await tokenFor(user.email);
      const before = await credentialsRow(user.id);

      const response = await changePassword(token, { currentPassword: 'not-my-password', newPassword: NEW_PASSWORD }).expect(403);

      expect(response.body).toEqual({ statusCode: 403, code: 'CURRENT_PASSWORD_INVALID', message: 'The current password is incorrect' });
      expect(await credentialsRow(user.id)).toEqual(before);
      await request(app.getHttpServer()).get('/auth/me').auth(token, { type: 'bearer' }).expect(200);
    });

    it.each<[string, object]>([
      ['a new password shorter than 8 characters', { currentPassword: PASSWORD, newPassword: 'short12' }],
      ['a new password longer than 72 characters', { currentPassword: PASSWORD, newPassword: 'p'.repeat(73) }],
      ['a missing new password', { currentPassword: PASSWORD }],
      ['an empty current password', { currentPassword: '', newPassword: NEW_PASSWORD }],
    ])('rejects %s with 400 and changes nothing', async (_label, body) => {
      const user = await createUser();
      const before = await credentialsRow(user.id);

      await changePassword(await tokenFor(user.email), body).expect(400);

      expect(await credentialsRow(user.id)).toEqual(before);
    });

    it('revokes every token issued before the change, including the one used to change it', async () => {
      const user = await createUser();
      const usedToken = await tokenFor(user.email);
      const otherToken = await tokenFor(user.email);

      await changePassword(usedToken, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(204, '');

      for (const token of [usedToken, otherToken]) {
        const response = await request(app.getHttpServer()).get('/auth/me').auth(token, { type: 'bearer' }).expect(401);
        expect(errorCode(response.body)).toBe('UNAUTHENTICATED');
      }
      await updateProfile(otherToken, { name: 'Too Late' }).expect(401);
      await changePassword(otherToken, { currentPassword: NEW_PASSWORD, newPassword: PASSWORD }).expect(401);
      expect(await credentialsRow(user.id)).toMatchObject({ name: 'Stock Keeper', sessionVersion: 1 });
    });

    it.each([8, 72])('signs in with a new password of %i characters and rejects the old one', async (length) => {
      const user = await createUser();
      const newPassword = 'p'.repeat(length);

      await changePassword(await tokenFor(user.email), { currentPassword: PASSWORD, newPassword }).expect(204);

      const old = await login(user.email, PASSWORD).expect(401);
      expect(errorCode(old.body)).toBe('INVALID_CREDENTIALS');
      const token = await tokenFor(user.email, newPassword);
      await request(app.getHttpServer()).get('/auth/me').auth(token, { type: 'bearer' }).expect(200);
    });

    it.each<[string, () => request.Test]>([
      ['PATCH /auth/me', () => updateProfile(undefined, { name: 'Anonymous' })],
      ['POST /auth/me/password', () => changePassword(undefined, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })],
    ])('denies %s without a token with 401', async (_label, call) => {
      const response = await call().expect(401);

      expect(errorCode(response.body)).toBe('UNAUTHENTICATED');
    });
  });

  describe('rate limit', () => {
    const LOGIN_LIMIT = 3;
    const ACCESS_REQUEST_LIMIT = 2;
    const SHORT_TTL_MS = 1000;
    const limits: RateLimitEnv = {
      THROTTLE_LOGIN_LIMIT: String(LOGIN_LIMIT),
      THROTTLE_LOGIN_TTL_MS: '60000',
      THROTTLE_ACCESS_REQUEST_LIMIT: String(ACCESS_REQUEST_LIMIT),
    };
    let limited: INestApplication<App>;
    let sibling: INestApplication<App>;
    let shortWindow: INestApplication<App>;
    let behindProxy: INestApplication<App>;
    let redis: Redis;

    function attempt(target: INestApplication<App>, forwardedFor?: string): request.Test {
      const pending = request(target.getHttpServer()).post('/auth/login').send({ email: 'nobody@example.test', password: PASSWORD });
      return forwardedFor === undefined ? pending : pending.set('X-Forwarded-For', forwardedFor);
    }

    function requestAccess(target: INestApplication<App>): request.Test {
      return request(target.getHttpServer())
        .post('/auth/access-requests')
        .send({ name: 'Requester', email: 'requester@example.test', password: 'a-strong-password' });
    }

    async function exhaustLogin(target: INestApplication<App>, forwardedFor?: string): Promise<void> {
      for (let index = 0; index < LOGIN_LIMIT; index += 1) {
        await attempt(target, forwardedFor).expect(401);
      }
    }

    function expectRateLimited(response: request.Response): void {
      expect(response.status).toBe(429);
      expect(response.body).toEqual({ statusCode: 429, code: 'RATE_LIMITED', message: 'Too many requests, please try again later' });
      expect(Number(response.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    }

    beforeAll(async () => {
      limited = await createAppWith(limits);
      sibling = await createAppWith(limits);
      shortWindow = await createAppWith({ ...limits, THROTTLE_LOGIN_TTL_MS: String(SHORT_TTL_MS) });
      behindProxy = await createAppWith({ ...limits, TRUST_PROXY_HOPS: '1' });
      redis = limited.get<Redis>(REDIS);
    });

    beforeEach(async () => {
      await clearThrottleKeys(redis);
    });

    afterAll(async () => {
      await clearThrottleKeys(redis);
      await Promise.all([limited, sibling, shortWindow, behindProxy].map((target) => target.close()));
    });

    it('answers login attempts up to the limit and rejects the next one with 429 and Retry-After', async () => {
      const user = await createUser();

      await request(limited.getHttpServer()).post('/auth/login').send({ email: user.email, password: PASSWORD }).expect(200);
      for (let index = 1; index < LOGIN_LIMIT; index += 1) {
        await attempt(limited).expect(401);
      }
      const blocked = await request(limited.getHttpServer()).post('/auth/login').send({ email: user.email, password: PASSWORD });

      expectRateLimited(blocked);
      expect(Number(blocked.headers['retry-after'])).toBeLessThanOrEqual(60);
    });

    it('accepts login attempts again once the window expires', async () => {
      await exhaustLogin(shortWindow);
      const blocked = await attempt(shortWindow);
      expectRateLimited(blocked);

      await new Promise((resolve) => setTimeout(resolve, SHORT_TTL_MS + 200));

      await attempt(shortWindow).expect(401);
    });

    it('shares the attempt count between instances backed by the same redis', async () => {
      for (let index = 0; index < LOGIN_LIMIT; index += 1) {
        await attempt(index % 2 === 0 ? limited : sibling).expect(401);
      }

      expectRateLimited(await attempt(sibling));
    });

    it('limits access requests with a counter independent from login', async () => {
      await exhaustLogin(limited);
      expectRateLimited(await attempt(limited));

      for (let index = 0; index < ACCESS_REQUEST_LIMIT; index += 1) {
        await requestAccess(limited).expect(202);
      }

      expectRateLimited(await requestAccess(limited));
    });

    it('keeps routes without a rate limit available after the login limit is reached', async () => {
      await exhaustLogin(limited);
      expectRateLimited(await attempt(limited));

      for (let index = 0; index <= LOGIN_LIMIT; index += 1) {
        await request(limited.getHttpServer()).get('/health').expect(200);
      }
    });

    it('counts each forwarded client address separately behind a trusted proxy', async () => {
      await exhaustLogin(behindProxy, '203.0.113.10');
      expectRateLimited(await attempt(behindProxy, '203.0.113.10'));

      await attempt(behindProxy, '203.0.113.20').expect(401);
    });

    it('ignores X-Forwarded-For when no proxy is trusted', async () => {
      await exhaustLogin(limited, '203.0.113.10');

      expectRateLimited(await attempt(limited, '203.0.113.20'));
    });
  });
});
