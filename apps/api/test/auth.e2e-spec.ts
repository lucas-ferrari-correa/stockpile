import { randomUUID } from 'node:crypto';
import { Controller, Get, INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Permission, UserStatus, authErrorSchema, loginResponseSchema, meResponseSchema } from '@stockpile/shared';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/infra/prisma/prisma.service';
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

interface UserInput {
  status?: UserStatus;
  roleId?: string;
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

  async function tokenFor(email: string): Promise<string> {
    const response = await request(app.getHttpServer()).post('/auth/login').send({ email, password: PASSWORD }).expect(200);
    return loginResponseSchema.parse(response.body).accessToken;
  }

  function errorCode(body: unknown): string {
    return authErrorSchema.parse(body).code;
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
      ['signed with another secret', (sub) => jwt.signAsync({ sub }, { secret: 'another-secret-with-at-least-32-characters' })],
      ['expired', (sub) => jwt.signAsync({ sub }, { expiresIn: -60 })],
      ['carrying a non uuid subject', () => jwt.signAsync({ sub: 'admin' })],
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
});
