import { PERMISSIONS, Permission, USER_STATUSES, UserStatus } from '@stockpile/shared';
import {
  AccessRequestOutcome,
  DeletedAtEffect,
  GovernanceSubject,
  InvalidUserTransitionError,
  SelfActionError,
  UserAction,
  UserEventKind,
  accessRequestOutcome,
  assertNotSelf,
  isActiveGovernor,
  isReRegistrationRequest,
  isRoleNoOp,
  removesGovernor,
  transitionFor,
} from './user-lifecycle';
import { holdsGovernance } from '../../auth/domain/permissions';

const ACTIONS: readonly UserAction[] = ['approve', 'reject', 'block', 'unblock', 'delete', 'changeRole'];
const PAST = new Date('2026-01-01T00:00:00.000Z');
const GOVERNANCE: readonly Permission[] = ['users:manage', 'roles:manage'];

const VALID: ReadonlyArray<[UserAction, UserStatus, UserStatus | 'unchanged', UserEventKind, DeletedAtEffect]> = [
  ['approve', 'PENDING', 'ACTIVE', 'APPROVED', 'clear'],
  ['reject', 'PENDING', 'REJECTED', 'REJECTED', 'clear'],
  ['block', 'ACTIVE', 'BLOCKED', 'BLOCKED', 'keep'],
  ['unblock', 'BLOCKED', 'ACTIVE', 'APPROVED', 'keep'],
  ['delete', 'PENDING', 'DELETED', 'DELETED', 'set'],
  ['delete', 'ACTIVE', 'DELETED', 'DELETED', 'set'],
  ['delete', 'BLOCKED', 'DELETED', 'DELETED', 'set'],
  ['delete', 'REJECTED', 'DELETED', 'DELETED', 'set'],
  ['changeRole', 'ACTIVE', 'unchanged', 'ROLE_CHANGED', 'keep'],
  ['changeRole', 'BLOCKED', 'unchanged', 'ROLE_CHANGED', 'keep'],
];

const INVALID: ReadonlyArray<[UserAction, UserStatus]> = ACTIONS.flatMap((action) =>
  USER_STATUSES.filter((status) => !VALID.some(([validAction, from]) => validAction === action && from === status)).map(
    (status): [UserAction, UserStatus] => [action, status],
  ),
);

function governor(overrides: Partial<GovernanceSubject> = {}): GovernanceSubject {
  return { status: 'ACTIVE', deletedAt: null, permissions: GOVERNANCE, ...overrides };
}

describe('user lifecycle', () => {
  describe('transitionFor', () => {
    it('classifies every action and status pair exactly once', () => {
      expect(VALID.length + INVALID.length).toBe(ACTIONS.length * USER_STATUSES.length);
      expect(INVALID).toHaveLength(20);
    });

    it.each(VALID)(
      'allows %s from %s, moving to %s, recording %s and applying %s to deletedAt',
      (action, from, to, event, deletedAt) => {
        expect(transitionFor(action, from)).toMatchObject({ to, event, deletedAt });
      },
    );

    it.each(INVALID)('refuses %s from %s', (action, from) => {
      let caught: unknown;
      try {
        transitionFor(action, from);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(InvalidUserTransitionError);
      expect(caught).toMatchObject({ action, from });
    });
  });

  describe('assertNotSelf', () => {
    it.each(ACTIONS.filter((action) => action !== 'changeRole'))('refuses %s when the actor is the target', (action) => {
      expect(() => assertNotSelf(action, 'same-id', 'same-id')).toThrow(SelfActionError);
    });

    it('accepts a role change of the own account', () => {
      expect(() => assertNotSelf('changeRole', 'same-id', 'same-id')).not.toThrow();
    });

    it('accepts an action on another user', () => {
      expect(() => assertNotSelf('block', 'target-id', 'actor-id')).not.toThrow();
    });
  });

  describe('isRoleNoOp', () => {
    it('is true for a role change to the role the user already holds', () => {
      expect(isRoleNoOp('changeRole', 'role-a', 'role-a')).toBe(true);
    });

    it.each<[UserAction, string | null, string | null]>([
      ['changeRole', 'role-a', 'role-b'],
      ['changeRole', null, 'role-a'],
      ['changeRole', null, null],
      ['approve', 'role-a', 'role-a'],
      ['block', 'role-a', 'role-a'],
    ])('is false for %s from %p to %p', (action, currentRoleId, nextRoleId) => {
      expect(isRoleNoOp(action, currentRoleId, nextRoleId)).toBe(false);
    });
  });

  describe('holdsGovernance', () => {
    it.each<[string, readonly Permission[], boolean]>([
      ['both governance permissions', GOVERNANCE, true],
      ['every permission', PERMISSIONS, true],
      ['only users:manage', ['users:manage'], false],
      ['only roles:manage', ['roles:manage'], false],
      ['no permission', [], false],
    ])('answers for %s', (_label, permissions, expected) => {
      expect(holdsGovernance(permissions)).toBe(expected);
    });
  });

  describe('isActiveGovernor', () => {
    it('is true for an active, not deleted user holding both governance permissions', () => {
      expect(isActiveGovernor(governor())).toBe(true);
    });

    it.each(USER_STATUSES.filter((status) => status !== 'ACTIVE'))('is false for a %s governor', (status) => {
      expect(isActiveGovernor(governor({ status }))).toBe(false);
    });

    it('is false for an active user carrying a deletion date', () => {
      expect(isActiveGovernor(governor({ deletedAt: PAST }))).toBe(false);
    });

    it('is false for an active user missing one governance permission', () => {
      expect(isActiveGovernor(governor({ permissions: ['users:manage', 'inventory:write'] }))).toBe(false);
    });
  });

  describe('removesGovernor', () => {
    it.each<UserAction>(['block', 'delete'])('is true when %s targets an active governor', (action) => {
      expect(removesGovernor(action, governor(), null)).toBe(true);
    });

    it.each<UserAction>(['approve', 'reject', 'unblock'])('is false for %s on an active governor', (action) => {
      expect(removesGovernor(action, governor(), GOVERNANCE)).toBe(false);
    });

    it.each<[string, readonly Permission[] | null, boolean]>([
      ['a role without roles:manage', ['users:manage', 'inventory:read'], true],
      ['a role without users:manage', ['roles:manage'], true],
      ['no resolved role', null, true],
      ['another role holding both permissions', [...GOVERNANCE, 'dashboard:view'], false],
    ])('answers a role change of an active governor to %s', (_label, nextPermissions, expected) => {
      expect(removesGovernor('changeRole', governor(), nextPermissions)).toBe(expected);
    });

    it.each<UserAction>(['block', 'delete', 'changeRole'])('is false for %s on a user who is not a governor', (action) => {
      expect(removesGovernor(action, governor({ permissions: ['users:manage'] }), [])).toBe(false);
    });

    it.each<UserAction>(['delete', 'changeRole'])('is false for %s on a blocked governor', (action) => {
      expect(removesGovernor(action, governor({ status: 'BLOCKED' }), [])).toBe(false);
    });
  });

  describe('accessRequestOutcome', () => {
    it('creates a request for an unknown email', () => {
      expect(accessRequestOutcome(null)).toBe('create');
    });

    it.each<[UserStatus, Date | null, AccessRequestOutcome]>([
      ['DELETED', PAST, 're-register'],
      ['PENDING', null, 'ignore'],
      ['ACTIVE', null, 'ignore'],
      ['PENDING', PAST, 'unavailable'],
      ['BLOCKED', null, 'unavailable'],
      ['REJECTED', null, 'unavailable'],
    ])('answers %s with deletedAt %p as %s', (status, deletedAt, outcome) => {
      expect(accessRequestOutcome({ status, deletedAt })).toBe(outcome);
    });
  });

  describe('isReRegistrationRequest', () => {
    it('is true only for a pending user that still carries a deletion date', () => {
      expect(isReRegistrationRequest({ status: 'PENDING', deletedAt: PAST })).toBe(true);
      expect(isReRegistrationRequest({ status: 'PENDING', deletedAt: null })).toBe(false);
    });

    it.each(USER_STATUSES.filter((status) => status !== 'PENDING'))(
      'is false for a %s user with a deletion date',
      (status) => {
        expect(isReRegistrationRequest({ status, deletedAt: PAST })).toBe(false);
      },
    );
  });
});
