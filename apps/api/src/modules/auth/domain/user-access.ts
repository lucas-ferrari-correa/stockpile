import { AuthErrorCode, UserStatus } from '@stockpile/shared';

export type LoginDenial = Extract<AuthErrorCode, 'INVALID_CREDENTIALS' | 'ACCOUNT_PENDING' | 'ACCOUNT_BLOCKED'>;

export interface AccessSubject {
  status: UserStatus;
  deletedAt: Date | null;
}

export function canAccess(subject: AccessSubject): boolean {
  return subject.status === 'ACTIVE' && subject.deletedAt === null;
}

export function isBlocked(subject: AccessSubject): boolean {
  return subject.status === 'BLOCKED' && subject.deletedAt === null;
}

export function loginDenialFor(subject: AccessSubject): LoginDenial | null {
  if (subject.deletedAt !== null) {
    return 'INVALID_CREDENTIALS';
  }
  switch (subject.status) {
    case 'ACTIVE':
      return null;
    case 'PENDING':
      return 'ACCOUNT_PENDING';
    case 'BLOCKED':
      return 'ACCOUNT_BLOCKED';
    case 'REJECTED':
    case 'DELETED':
      return 'INVALID_CREDENTIALS';
  }
}
