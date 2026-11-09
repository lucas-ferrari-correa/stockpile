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
  sv: number;
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
      select: { id: true, passwordHash: true, sessionVersion: true, status: true, deletedAt: true, roleId: true },
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

    const payload: AccessTokenPayload = { sub: user.id, sv: user.sessionVersion };
    return {
      accessToken: await this.jwt.signAsync(payload),
      tokenType: 'Bearer',
      expiresIn: this.config.get('JWT_EXPIRES_IN_SECONDS'),
    };
  }

  async resolveActiveUser(userId: string, sessionVersion: number): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        sessionVersion: true,
        status: true,
        deletedAt: true,
        role: { select: { id: true, name: true, permissions: { select: { permission: true } } } },
      },
    });

    if (!user || user.sessionVersion !== sessionVersion) {
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

  async updateProfile(current: AuthUser, name: string): Promise<AuthUser> {
    const updated = await this.prisma.user.update({
      where: { id: current.id },
      data: { name },
      select: { name: true },
    });
    return { ...current, name: updated.name };
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    });
    if (!user) {
      throw unauthorized('UNAUTHENTICATED');
    }
    if (!(await this.hasher.verify(currentPassword, user.passwordHash))) {
      throw forbidden('CURRENT_PASSWORD_INVALID');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await this.hasher.hash(newPassword), sessionVersion: { increment: 1 } },
      select: { id: true },
    });
  }

  private dummyHash(): Promise<string> {
    this.timingGuardHash ??= this.hasher.hash(randomUUID());
    return this.timingGuardHash;
  }
}
