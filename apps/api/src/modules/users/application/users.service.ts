import { Injectable } from '@nestjs/common';
import { Prisma, UserStatus } from '@prisma/client';
import { Permission, UserListItem, UserListQuery, UserPage, UserSort } from '@stockpile/shared';
import { z } from 'zod';
import { ListingDefinition, ListingModel, ListingService, enumSearch, listingColumns } from '../../../infra/listing/listing';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { runSerializable } from '../../../infra/prisma/serializable';
import { countActiveGovernors } from '../../auth/application/governance';
import { toPermissions } from '../../auth/domain/permissions';
import {
  DeletedAtEffect,
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

interface UsersListingModel extends ListingModel<UserSort> {
  row: UserRecord;
  where: Prisma.UserWhereInput;
  orderBy: Prisma.UserOrderByWithRelationInput;
  query: UserListQuery;
  context: null;
}

const columns = listingColumns<UserRecord, Prisma.UserWhereInput, Prisma.UserOrderByWithRelationInput>();

const USER_STATUS_ORDER: readonly UserStatus[] = Object.values(UserStatus);

export const USERS_LISTING: ListingDefinition<UsersListingModel, UserSort, 'status' | 'roleId'> = {
  sorts: {
    name: columns.text({ where: (name) => ({ name }), orderBy: (name) => ({ name }), read: (row) => row.name }),
    email: columns.text({ where: (email) => ({ email }), orderBy: (email) => ({ email }), read: (row) => row.email }),
    status: columns.enum({
      values: USER_STATUS_ORDER,
      where: (status) => ({ status }),
      orderBy: (status) => ({ status }),
      read: (row) => row.status,
    }),
    createdAt: columns.instant({
      where: (createdAt) => ({ createdAt }),
      orderBy: (createdAt) => ({ createdAt }),
      read: (row) => row.createdAt,
    }),
  },
  id: columns.id({ schema: z.uuid(), where: (id) => ({ id }), orderBy: (id) => ({ id }), read: (row) => row.id }),
  filters: {
    status: (status) => ({ status: { in: status } }),
    roleId: (roleId) => ({ roleId: { in: roleId } }),
  },
  created: (createdAt) => ({ createdAt }),
  search: {
    text: [(name) => ({ name }), (email) => ({ email })],
    enums: [enumSearch(USER_STATUS_ORDER, (status) => ({ status: { in: status } }))],
    dates: { kind: 'instant', columns: [(createdAt) => ({ createdAt })] },
  },
  scope: () => ({}),
  and: (AND) => ({ AND }),
  or: (OR) => ({ OR }),
  invalidCursor,
};

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

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly listing: ListingService,
  ) {}

  async list(query: UserListQuery): Promise<UserPage> {
    const page = await this.listing.page(USERS_LISTING, query, null, {
      findMany: (args) =>
        this.prisma.user.findMany({
          ...args,
          select: {
            id: true,
            name: true,
            email: true,
            status: true,
            createdAt: true,
            deletedAt: true,
            role: { select: { id: true, name: true } },
          },
        }),
      dateBounds: async (where) => {
        const bounds = await this.prisma.user.aggregate({ where, _min: { createdAt: true }, _max: { createdAt: true } });
        return [bounds._min.createdAt, bounds._max.createdAt];
      },
      total: ({ where, paged }) => (paged ? Promise.resolve(null) : this.prisma.user.count({ where })),
    });

    return { items: page.rows.map(toUserListItem), nextCursor: page.nextCursor, total: page.total };
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

    return runSerializable(this.prisma, (tx) => this.applyWithin(tx, command, targetId, actorId));
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
        role: { select: { id: true, name: true, permissions: { select: { permission: true }, orderBy: { permission: 'asc' } } } },
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
      const otherGovernors = await countActiveGovernors(tx, { id: target.id });
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
      select: { id: true, permissions: { select: { permission: true }, orderBy: { permission: 'asc' } } },
    });
    if (!role) {
      throw roleNotFound();
    }
    return { id: role.id, permissions: toPermissions(role.permissions.map(({ permission }) => permission)) };
  }
}
