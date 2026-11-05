import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ACCESS_REQUEST_ACCEPTED_MESSAGE, AccessRequest, AccessRequestResponse } from '@stockpile/shared';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { forbidden } from '../../auth/application/auth.errors';
import { PASSWORD_HASHER, PasswordHasher } from '../../auth/ports/password-hasher.port';
import { accessRequestOutcome } from '../domain/user-lifecycle';

const ACCESS_REQUESTED: AccessRequestResponse = {
  code: 'ACCESS_REQUESTED',
  message: ACCESS_REQUEST_ACCEPTED_MESSAGE,
};

@Injectable()
export class AccessRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
  ) { }

  async request(input: AccessRequest): Promise<AccessRequestResponse> {
    const passwordHash = await this.hasher.hash(input.password);
    const existing = await this.prisma.user.findUnique({
      where: { email: input.email },
      select: { id: true, status: true, deletedAt: true },
    });

    const outcome = accessRequestOutcome(existing);
    switch (outcome) {
      case 'create':
        await this.create(input, passwordHash);
        return ACCESS_REQUESTED;
      case 're-register':
        if (existing) {
          await this.reRegister(existing.id, input.name, passwordHash);
        }
        throw forbidden('ACCOUNT_UNAVAILABLE');
      case 'ignore':
        return ACCESS_REQUESTED;
      case 'unavailable':
        throw forbidden('ACCOUNT_UNAVAILABLE');
    }
  }

  private async create(input: AccessRequest, passwordHash: string): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { name: input.name, email: input.email, passwordHash, status: 'PENDING', roleId: null },
          select: { id: true },
        });

        await tx.userEvent.create({
          data: { userId: user.id, actorId: null, type: 'REQUESTED', reRegistration: false },
          select: { id: true },
        });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return;
      }

      throw error;
    }
  }

  private async reRegister(userId: string, name: string, passwordHash: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.updateMany({
        where: { id: userId, status: 'DELETED' },
        data: { name, passwordHash, status: 'PENDING', roleId: null },
      });

      if (updated.count === 0) {
        return;
      }

      await tx.userEvent.create({
        data: { userId, actorId: null, type: 'REQUESTED', reRegistration: true },
        select: { id: true },
      });
    });
  }
}
