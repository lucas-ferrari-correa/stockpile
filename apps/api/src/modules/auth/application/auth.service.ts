import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthUser, LoginResponse } from '@stockpile/shared';
import { AppConfigService } from '../../../infra/config/app-config.service';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { toPermissions } from '../domain/permissions';
import { canAccess, isBlocked, loginDenialFor } from '../domain/user-access';
import { PASSWORD_HASHER, PasswordHasher } from '../ports/password-hasher.port';
import { forbidden, unauthorized } from './auth.errors';

export interface AccessTokenPayload {
  sub: string;
}

@Injectable()
export class AuthService {
  private timingGuardHash: Promise<string> | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
  ) {}

  async login(email: string, password: string): Promise<LoginResponse> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, passwordHash: true, status: true, deletedAt: true, roleId: true },
    });

    if (!user) {
      await this.hasher.verify(password, await this.dummyHash());
      throw unauthorized('INVALID_CREDENTIALS');
    }

    const passwordMatches = await this.hasher.verify(password, user.passwordHash);
    const denial = loginDenialFor(user);

    if (!passwordMatches || denial === 'INVALID_CREDENTIALS') {
      throw unauthorized('INVALID_CREDENTIALS');
    }
    if (denial !== null) {
      throw forbidden(denial);
    }
    if (user.roleId === null) {
      throw unauthorized('INVALID_CREDENTIALS');
    }

    const payload: AccessTokenPayload = { sub: user.id };
    return {
      accessToken: await this.jwt.signAsync(payload),
      tokenType: 'Bearer',
      expiresIn: this.config.get('JWT_EXPIRES_IN_SECONDS'),
    };
  }

  async resolveActiveUser(userId: string): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        status: true,
        deletedAt: true,
        role: { select: { id: true, name: true, permissions: { select: { permission: true } } } },
      },
    });

    if (!user) {
      throw unauthorized('UNAUTHENTICATED');
    }
    if (isBlocked(user)) {
      throw forbidden('ACCOUNT_BLOCKED');
    }
    if (!canAccess(user) || !user.role) {
      throw unauthorized('UNAUTHENTICATED');
    }

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      status: user.status,
      role: { id: user.role.id, name: user.role.name },
      permissions: toPermissions(user.role.permissions.map(({ permission }) => permission)),
    };
  }

  private dummyHash(): Promise<string> {
    this.timingGuardHash ??= this.hasher.hash(randomUUID());
    return this.timingGuardHash;
  }
}
