import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CreateRole, Permission, Role, RoleList, RoleListItem, UpdateRole } from '@stockpile/shared';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { runSerializable } from '../../../infra/prisma/serializable';
import { countActiveGovernors } from '../../auth/application/governance';
import { toPermissions } from '../../auth/domain/permissions';
import { dropsGovernance, isImmutableRole } from '../domain/role-rules';
import { roleConflict, roleInUse, roleNotFound } from './roles.errors';

interface RoleRecord {
  id: string;
  name: string;
  system: boolean;
  createdAt: Date;
  updatedAt: Date;
  permissions: { permission: string }[];
}

function toRole(role: RoleRecord): Role {
  return {
    id: role.id,
    name: role.name,
    system: role.system,
    permissions: toPermissions(role.permissions.map(({ permission }) => permission)),
    createdAt: role.createdAt.toISOString(),
    updatedAt: role.updatedAt.toISOString(),
  };
}

function isRoleNameViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002' && error.meta?.modelName === 'Role'
  );
}

async function assertNameAvailable(tx: Prisma.TransactionClient, name: string, exceptId?: string): Promise<void> {
  const candidates = await tx.role.findMany({
    where: {
      name: { equals: name, mode: 'insensitive' },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { name: true },
  });
  const normalized = name.toLowerCase();
  if (candidates.some((candidate) => candidate.name.toLowerCase() === normalized)) {
    throw roleConflict('ROLE_NAME_TAKEN');
  }
}

@Injectable()
export class RolesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<RoleList> {
    const roles = await this.prisma.role.findMany({
      orderBy: [{ system: 'desc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        system: true,
        createdAt: true,
        updatedAt: true,
        permissions: { select: { permission: true } },
        _count: { select: { users: { where: { deletedAt: null } } } },
      },
    });
    return {
      items: roles.map((role): RoleListItem => ({ ...toRole(role), userCount: role._count.users })),
    };
  }

  async get(id: string): Promise<Role> {
    const role = await this.prisma.role.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        system: true,
        createdAt: true,
        updatedAt: true,
        permissions: { select: { permission: true } },
      },
    });
    if (!role) {
      throw roleNotFound();
    }
    return toRole(role);
  }

  async create(input: CreateRole): Promise<Role> {
    return this.withNameConflict(() =>
      runSerializable(this.prisma, async (tx) => {
        await assertNameAvailable(tx, input.name);
        const created = await tx.role.create({
          data: {
            name: input.name,
            permissions: { createMany: { data: input.permissions.map((permission) => ({ permission })) } },
          },
          select: {
            id: true,
            name: true,
            system: true,
            createdAt: true,
            updatedAt: true,
            permissions: { select: { permission: true } },
          },
        });
        return toRole(created);
      }),
    );
  }

  async update(id: string, input: UpdateRole): Promise<Role> {
    return this.withNameConflict(() => runSerializable(this.prisma, (tx) => this.updateWithin(tx, id, input)));
  }

  async remove(id: string): Promise<void> {
    await runSerializable(this.prisma, async (tx) => {
      const role = await tx.role.findUnique({
        where: { id },
        select: { id: true, system: true, _count: { select: { users: { where: { deletedAt: null } } } } },
      });
      if (!role) {
        throw roleNotFound();
      }
      if (isImmutableRole(role)) {
        throw roleConflict('SYSTEM_ROLE_IMMUTABLE');
      }
      if (role._count.users > 0) {
        throw roleInUse(role._count.users);
      }
      await tx.user.updateMany({
        where: { roleId: role.id, deletedAt: { not: null } },
        data: { roleId: null },
      });
      await tx.role.delete({ where: { id: role.id }, select: { id: true } });
    });
  }

  private async updateWithin(tx: Prisma.TransactionClient, id: string, input: UpdateRole): Promise<Role> {
    const role = await tx.role.findUnique({
      where: { id },
      select: { id: true, system: true, permissions: { select: { permission: true } } },
    });
    if (!role) {
      throw roleNotFound();
    }
    if (isImmutableRole(role)) {
      throw roleConflict('SYSTEM_ROLE_IMMUTABLE');
    }
    if (input.name !== undefined) {
      await assertNameAvailable(tx, input.name, role.id);
    }
    if (input.permissions !== undefined) {
      await this.assertKeepsGovernance(tx, role.id, role.permissions, input.permissions);
    }

    const updated = await tx.role.update({
      where: { id: role.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.permissions !== undefined
          ? {
              permissions: {
                deleteMany: {},
                createMany: { data: input.permissions.map((permission) => ({ permission })) },
              },
            }
          : {}),
      },
      select: {
        id: true,
        name: true,
        system: true,
        createdAt: true,
        updatedAt: true,
        permissions: { select: { permission: true } },
      },
    });
    return toRole(updated);
  }

  private async assertKeepsGovernance(
    tx: Prisma.TransactionClient,
    roleId: string,
    current: { permission: string }[],
    next: readonly Permission[],
  ): Promise<void> {
    if (!dropsGovernance(toPermissions(current.map(({ permission }) => permission)), next)) {
      return;
    }
    const otherGovernors = await countActiveGovernors(tx, { roleId });
    if (otherGovernors === 0) {
      throw roleConflict('LAST_ADMIN_PROTECTED');
    }
  }

  private async withNameConflict<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (isRoleNameViolation(error)) {
        throw roleConflict('ROLE_NAME_TAKEN');
      }
      throw error;
    }
  }
}
