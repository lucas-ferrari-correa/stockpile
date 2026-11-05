import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { AuthError, UserStatus, authErrorSchema } from '@stockpile/shared';
import { AppConfigService } from '../../../infra/config/app-config.service';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { PASSWORD_HASHER, PasswordHasher } from '../ports/password-hasher.port';
import { AccessTokenPayload, AuthService } from './auth.service';

const JWT_SECRET = 'unit-test-jwt-secret-with-at-least-32-chars';
const PASSWORD = 'correct-horse-battery';

interface StoredRole {
  id: string;
  name: string;
  permissions: { permission: string }[];
}

interface StoredUser {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  status: UserStatus;
  deletedAt: Date | null;
  roleId: string | null;
  role: StoredRole | null;
}

interface FindUniqueArgs {
  where: { email?: string; id?: string };
}

class FakePasswordHasher implements PasswordHasher {
  readonly verifyCalls: { password: string; passwordHash: string }[] = [];

  hash(password: string): Promise<string> {
    return Promise.resolve(`hashed:${password}`);
  }

  verify(password: string, passwordHash: string): Promise<boolean> {
    this.verifyCalls.push({ password, passwordHash });
    return Promise.resolve(passwordHash === `hashed:${password}`);
  }
}

class FakePrisma {
  readonly users: StoredUser[] = [];

  readonly user = {
    findUnique: ({ where }: FindUniqueArgs): Promise<StoredUser | null> =>
      Promise.resolve(
        this.users.find((user) => (where.email !== undefined ? user.email === where.email : user.id === where.id)) ??
          null,
      ),
  };
}

describe('AuthService', () => {
  let service: AuthService;
  let jwt: JwtService;
  let config: AppConfigService;
  let prisma: FakePrisma;
  let hasher: FakePasswordHasher;

  function storeUser(overrides: Partial<StoredUser> = {}): StoredUser {
    const role: StoredRole = { id: randomUUID(), name: 'viewer', permissions: [{ permission: 'inventory:read' }] };
    const user: StoredUser = {
      id: randomUUID(),
      name: 'Stock Keeper',
      email: `${randomUUID()}@example.test`,
      passwordHash: `hashed:${PASSWORD}`,
      status: 'ACTIVE',
      deletedAt: null,
      roleId: role.id,
      role,
      ...overrides,
    };
    prisma.users.push(user);
    return user;
  }

  async function failure(promise: Promise<unknown>): Promise<{ status: number; body: AuthError }> {
    const error: unknown = await promise.then(
      () => null,
      (reason: unknown) => reason,
    );
    if (!(error instanceof HttpException)) {
      throw new Error('Expected an HttpException');
    }
    return { status: error.getStatus(), body: authErrorSchema.parse(error.getResponse()) };
  }

  beforeEach(async () => {
    prisma = new FakePrisma();
    hasher = new FakePasswordHasher();
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: JWT_SECRET })],
      providers: [
        AuthService,
        AppConfigService,
        { provide: PrismaService, useValue: prisma },
        { provide: PASSWORD_HASHER, useValue: hasher },
      ],
    }).compile();

    service = moduleRef.get(AuthService);
    jwt = moduleRef.get(JwtService);
    config = moduleRef.get(AppConfigService);
  });

  describe('login', () => {
    it('issues a bearer token whose subject is the user id for an active user', async () => {
      const user = storeUser();

      const response = await service.login(user.email, PASSWORD);

      expect(response.tokenType).toBe('Bearer');
      expect(response.expiresIn).toBe(config.get('JWT_EXPIRES_IN_SECONDS'));
      const payload = await jwt.verifyAsync<AccessTokenPayload>(response.accessToken);
      expect(payload.sub).toBe(user.id);
    });

    it('answers a wrong password and an unknown email with the same invalid credentials error', async () => {
      const user = storeUser();

      const wrongPassword = await failure(service.login(user.email, 'wrong-password'));
      const unknownEmail = await failure(service.login('nobody@example.test', PASSWORD));

      expect(wrongPassword).toEqual({
        status: 401,
        body: { statusCode: 401, code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' },
      });
      expect(unknownEmail).toEqual(wrongPassword);
    });

    it('still verifies a password against a dummy hash when the email is unknown', async () => {
      await failure(service.login('nobody@example.test', PASSWORD));

      expect(hasher.verifyCalls).toHaveLength(1);
      expect(hasher.verifyCalls[0]?.password).toBe(PASSWORD);
    });

    it.each<[UserStatus, number, AuthError['code']]>([
      ['PENDING', 403, 'ACCOUNT_PENDING'],
      ['BLOCKED', 403, 'ACCOUNT_BLOCKED'],
      ['REJECTED', 401, 'INVALID_CREDENTIALS'],
      ['DELETED', 401, 'INVALID_CREDENTIALS'],
    ])('denies a %s user with the right password with %i %s', async (status, httpStatus, code) => {
      const user = storeUser({ status });

      const result = await failure(service.login(user.email, PASSWORD));

      expect(result.status).toBe(httpStatus);
      expect(result.body.code).toBe(code);
    });

    it('treats a soft deleted user as unknown even if the status is still active', async () => {
      const user = storeUser({ deletedAt: new Date() });

      const result = await failure(service.login(user.email, PASSWORD));

      expect(result.body.code).toBe('INVALID_CREDENTIALS');
    });

    it('answers an active user without a role with the same body as a wrong password', async () => {
      const roleless = storeUser({ roleId: null, role: null });
      const other = storeUser();

      const withoutRole = await failure(service.login(roleless.email, PASSWORD));
      const wrongPassword = await failure(service.login(other.email, 'wrong-password'));

      expect(withoutRole.status).toBe(401);
      expect(withoutRole).toEqual(wrongPassword);
    });

    it('keeps answering a pending user without a role with 403 account pending', async () => {
      const user = storeUser({ status: 'PENDING', roleId: null, role: null });

      const result = await failure(service.login(user.email, PASSWORD));

      expect(result.status).toBe(403);
      expect(result.body.code).toBe('ACCOUNT_PENDING');
    });

    it.each<UserStatus>(['PENDING', 'BLOCKED'])(
      'does not reveal the %s status when the password is wrong',
      async (status) => {
        const user = storeUser({ status });

        const result = await failure(service.login(user.email, 'wrong-password'));

        expect(result.status).toBe(401);
        expect(result.body.code).toBe('INVALID_CREDENTIALS');
      },
    );
  });

  describe('resolveActiveUser', () => {
    it('returns the active user with role and the catalogued permissions only', async () => {
      const role: StoredRole = {
        id: randomUUID(),
        name: 'stock-editor',
        permissions: [{ permission: 'inventory:read' }, { permission: 'legacy:unknown' }, { permission: 'inventory:write' }],
      };
      const user = storeUser({ roleId: role.id, role });

      await expect(service.resolveActiveUser(user.id)).resolves.toEqual({
        id: user.id,
        name: user.name,
        email: user.email,
        status: 'ACTIVE',
        role: { id: role.id, name: 'stock-editor' },
        permissions: ['inventory:read', 'inventory:write'],
      });
    });

    it('denies a blocked user with 403 account blocked', async () => {
      const user = storeUser({ status: 'BLOCKED' });

      const result = await failure(service.resolveActiveUser(user.id));

      expect(result).toEqual({
        status: 403,
        body: { statusCode: 403, code: 'ACCOUNT_BLOCKED', message: 'Your account has been blocked' },
      });
    });

    it.each<[string, Partial<StoredUser>]>([
      ['pending', { status: 'PENDING' }],
      ['rejected', { status: 'REJECTED' }],
      ['deleted', { status: 'DELETED' }],
      ['soft deleted', { deletedAt: new Date() }],
      ['soft deleted and blocked', { status: 'BLOCKED', deletedAt: new Date() }],
    ])('denies a %s user with 401 unauthenticated', async (_label, overrides) => {
      const user = storeUser(overrides);

      const result = await failure(service.resolveActiveUser(user.id));

      expect(result.status).toBe(401);
      expect(result.body.code).toBe('UNAUTHENTICATED');
    });

    it('denies a token subject that no longer exists with 401 unauthenticated', async () => {
      const result = await failure(service.resolveActiveUser(randomUUID()));

      expect(result.status).toBe(401);
      expect(result.body.code).toBe('UNAUTHENTICATED');
    });
  });
});
