import { Permission, UserStatus } from '@stockpile/shared';

export type UserAction = 'approve' | 'reject' | 'block' | 'unblock' | 'delete' | 'changeRole';

export type UserEventKind = 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'BLOCKED' | 'DELETED' | 'ROLE_CHANGED';

export type DeletedAtEffect = 'keep' | 'clear' | 'set';

export interface UserTransition {
  from: readonly UserStatus[];
  to: UserStatus | 'unchanged';
  event: UserEventKind;
  deletedAt: DeletedAtEffect;
}

export const USER_TRANSITIONS: Readonly<Record<UserAction, UserTransition>> = {
  approve: { from: ['PENDING'], to: 'ACTIVE', event: 'APPROVED', deletedAt: 'clear' },
  reject: { from: ['PENDING'], to: 'REJECTED', event: 'REJECTED', deletedAt: 'clear' },
  block: { from: ['ACTIVE'], to: 'BLOCKED', event: 'BLOCKED', deletedAt: 'keep' },
  unblock: { from: ['BLOCKED'], to: 'ACTIVE', event: 'APPROVED', deletedAt: 'keep' },
  delete: { from: ['PENDING', 'ACTIVE', 'BLOCKED', 'REJECTED'], to: 'DELETED', event: 'DELETED', deletedAt: 'set' },
  changeRole: { from: ['ACTIVE', 'BLOCKED'], to: 'unchanged', event: 'ROLE_CHANGED', deletedAt: 'keep' },
};

export const GOVERNANCE_PERMISSIONS: readonly Permission[] = ['users:manage', 'roles:manage'];

export class InvalidUserTransitionError extends Error {
  constructor(
    readonly action: UserAction,
    readonly from: UserStatus,
  ) {
    super(`Cannot ${action} a user whose status is ${from}`);
    this.name = 'InvalidUserTransitionError';
  }
}

export class SelfActionError extends Error {
  constructor(readonly action: UserAction) {
    super(`Cannot ${action} your own account`);
    this.name = 'SelfActionError';
  }
}

export function assertNotSelf(action: UserAction, targetId: string, actorId: string): void {
  if (action !== 'changeRole' && targetId === actorId) {
    throw new SelfActionError(action);
  }
}

export function transitionFor(action: UserAction, from: UserStatus): UserTransition {
  const transition = USER_TRANSITIONS[action];
  if (!transition.from.includes(from)) {
    throw new InvalidUserTransitionError(action, from);
  }
  return transition;
}

export function holdsGovernance(permissions: readonly Permission[]): boolean {
  return GOVERNANCE_PERMISSIONS.every((permission) => permissions.includes(permission));
}

export interface GovernanceSubject {
  status: UserStatus;
  deletedAt: Date | null;
  permissions: readonly Permission[];
}

export function isActiveGovernor(subject: GovernanceSubject): boolean {
  return subject.status === 'ACTIVE' && subject.deletedAt === null && holdsGovernance(subject.permissions);
}

export function removesGovernor(
  action: UserAction,
  target: GovernanceSubject,
  nextPermissions: readonly Permission[] | null,
): boolean {
  if (!isActiveGovernor(target)) {
    return false;
  }
  switch (action) {
    case 'block':
    case 'delete':
      return true;
    case 'changeRole':
      return nextPermissions === null || !holdsGovernance(nextPermissions);
    case 'approve':
    case 'reject':
    case 'unblock':
      return false;
  }
}

export function isRoleNoOp(action: UserAction, currentRoleId: string | null, nextRoleId: string | null): boolean {
  return action === 'changeRole' && nextRoleId !== null && currentRoleId === nextRoleId;
}

export type AccessRequestOutcome = 'create' | 're-register' | 'ignore' | 'unavailable';

export interface AccessRequestSubject {
  status: UserStatus;
  deletedAt: Date | null;
}

export function accessRequestOutcome(existing: AccessRequestSubject | null): AccessRequestOutcome {
  if (existing === null) {
    return 'create';
  }
  switch (existing.status) {
    case 'DELETED':
      return 're-register';
    case 'PENDING':
      return existing.deletedAt === null ? 'ignore' : 'unavailable';
    case 'ACTIVE':
      return 'ignore';
    case 'BLOCKED':
    case 'REJECTED':
      return 'unavailable';
  }
}

export function isReRegistrationRequest(user: AccessRequestSubject): boolean {
  return user.status === 'PENDING' && user.deletedAt !== null;
}
