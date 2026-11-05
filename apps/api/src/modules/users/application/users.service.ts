import { Injectable } from '@nestjs/common';
import { Prisma, UserStatus } from '@prisma/client';
import { Permission, UserListItem, UserListQuery, UserPage } from '@stockpile/shared';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { toPermissions } from '../../auth/domain/permissions';
import {
  DeletedAtEffect,
  GOVERNANCE_PERMISSIONS,
  InvalidUserTransitionError,
  SelfActionError,
  UserAction,
  UserTransition,
  assertNotSelf,
  isReRegistrationRequest,
  isRoleNoOp,
  removesGovernor,
  transitionFor,
} from '../domain/user-lifecycle';
import { invalidCursor, roleNotFound, userConflict, userNotFound } from './users.errors';

const SERIALIZATION_RETRIES = 3;

export type UserCommand =
  | { action: 'approve'; roleId: string }
  | { action: 'changeRole'; roleId: string }
  | { action: 'reject' | 'block' | 'unblock' | 'delete' };

export interface UserRecord {
  id: string;
  name: string;
  email: string;
  status: UserStatus;
  createdAt: Date;
  deletedAt: Date | null;
  role: { id: string; name: string } | null;
}

export function toUserListItem(user: UserRecord): UserListItem {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    status: user.status,
    role: user.role ? { id: user.role.id, name: user.role.name } : null,
    createdAt: user.createdAt.toISOString(),
    deletedAt: user.deletedAt?.toISOString() ?? null,
    reRequestOfDeleted: isReRegistrationRequest(user),
  };
}

function deletedAtUpdate(effect: DeletedAtEffect): { deletedAt?: Date | null } {
  switch (effect) {
    case 'keep':
      return {};
    case 'clear':
      return { deletedAt: null };
    case 'set':
      return { deletedAt: new Date() };
  }
}

function statusUpdate(transition: UserTransition): { status?: UserStatus } {
  return transition.to === 'unchanged' ? {} : { status: transition.to };
}

function isSerializationFailure(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: UserListQuery): Promise<UserPage> {
    if (query.cursor) {
      const cursorUser = await this.prisma.user.findUnique({
        where: { id: query.cursor },
        select: { id: true },
      });
      if (!cursorUser) {
        throw invalidCursor();
      }
    }

    const rows: UserRecord[] = await this.prisma.user.findMany({
      where: { status: query.status },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        name: true,
        email: true,
        status: true,
        createdAt: true,
        deletedAt: true,
        role: { select: { id: true, name: true } },
      },
    });

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page.at(-1);
    return {
      items: page.map(toUserListItem),
      nextCursor: hasMore && last ? last.id : null,
    };
  }

  async apply(command: UserCommand, targetId: string, actorId: string): Promise<UserListItem> {
    try {
      assertNotSelf(command.action, targetId, actorId);
    } catch (error) {
      if (error instanceof SelfActionError) {
        throw userConflict('SELF_ACTION_FORBIDDEN');
      }
      throw error;
    }

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.prisma.$transaction((tx) => this.applyWithin(tx, command, targetId, actorId), {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (!isSerializationFailure(error) || attempt >= SERIALIZATION_RETRIES) {
          throw error;
        }
      }
    }
  }

  private async applyWithin(
    tx: Prisma.TransactionClient,
    command: UserCommand,
    targetId: string,
    actorId: string,
  ): Promise<UserListItem> {
    const target = await tx.user.findUnique({
      where: { id: targetId },
      select: {
        id: true,
        name: true,
        email: true,
        status: true,
        createdAt: true,
        deletedAt: true,
        role: { select: { id: true, name: true, permissions: { select: { permission: true } } } },
      },
    });
    if (!target) {
      throw userNotFound();
    }

    const transition = this.transitionOrConflict(command.action, target.status);
    const nextRole = await this.resolveNextRole(tx, command);
    if (isRoleNoOp(command.action, target.role?.id ?? null, nextRole?.id ?? null)) {
      return toUserListItem(target);
    }

    const targetPermissions = toPermissions(target.role?.permissions.map(({ permission }) => permission) ?? []);
    if (
      removesGovernor(
        command.action,
        { status: target.status, deletedAt: target.deletedAt, permissions: targetPermissions },
        nextRole?.permissions ?? null,
      )
    ) {
      const otherGovernors = await tx.user.count({
        where: {
          id: { not: target.id },
          status: 'ACTIVE',
          deletedAt: null,
          AND: GOVERNANCE_PERMISSIONS.map((permission) => ({
            role: { permissions: { some: { permission } } },
          })),
        },
      });
      if (otherGovernors === 0) {
        throw userConflict('LAST_ADMIN_PROTECTED');
      }
    }

    const updated: UserRecord = await tx.user.update({
      where: { id: target.id },
      data: {
        ...statusUpdate(transition),
        ...deletedAtUpdate(transition.deletedAt),
        ...(nextRole ? { roleId: nextRole.id } : {}),
      },
      select: {
        id: true,
        name: true,
        email: true,
        status: true,
        createdAt: true,
        deletedAt: true,
        role: { select: { id: true, name: true } },
      },
    });

    await tx.userEvent.create({
      data: { userId: target.id, actorId, type: transition.event },
      select: { id: true },
    });

    return toUserListItem(updated);
  }

  private transitionOrConflict(action: UserAction, status: UserStatus): UserTransition {
    try {
      return transitionFor(action, status);
    } catch (error) {
      if (error instanceof InvalidUserTransitionError) {
        throw userConflict('INVALID_TRANSITION');
      }
      throw error;
    }
  }

  private async resolveNextRole(
    tx: Prisma.TransactionClient,
    command: UserCommand,
  ): Promise<{ id: string; permissions: Permission[] } | null> {
    if (command.action !== 'approve' && command.action !== 'changeRole') {
      return null;
    }
    const role = await tx.role.findUnique({
      where: { id: command.roleId },
      select: { id: true, permissions: { select: { permission: true } } },
    });
    if (!role) {
      throw roleNotFound();
    }
    return { id: role.id, permissions: toPermissions(role.permissions.map(({ permission }) => permission)) };
  }
}
