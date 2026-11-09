import { Prisma } from '@prisma/client';
import { GOVERNANCE_PERMISSIONS } from '../domain/permissions';

export function countActiveGovernors(tx: Prisma.TransactionClient, excluding: Prisma.UserWhereInput): Promise<number> {
  return tx.user.count({
    where: {
      NOT: excluding,
      status: 'ACTIVE',
      deletedAt: null,
      AND: GOVERNANCE_PERMISSIONS.map((permission) => ({
        role: { permissions: { some: { permission } } },
      })),
    },
  });
}
