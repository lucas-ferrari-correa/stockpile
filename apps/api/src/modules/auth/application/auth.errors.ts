import { ForbiddenException, HttpStatus, UnauthorizedException } from '@nestjs/common';
import { AuthError } from '@stockpile/shared';

const MESSAGES = {
  UNAUTHENTICATED: 'Authentication is required',
  INVALID_CREDENTIALS: 'Invalid email or password',
  ACCOUNT_PENDING: 'Your account is awaiting approval by an administrator',
  ACCOUNT_BLOCKED: 'Your account has been blocked',
  ACCOUNT_UNAVAILABLE:
    'This account does not have access. It may have been blocked, rejected or deleted. If it was deleted, a re-registration request has been sent to the administrator.',
  ACCESS_DENIED: 'You do not have permission to access this resource',
  CURRENT_PASSWORD_INVALID: 'The current password is incorrect',
} as const satisfies Record<AuthError['code'], string>;

export function unauthorized(code: 'UNAUTHENTICATED' | 'INVALID_CREDENTIALS'): UnauthorizedException {
  const body: AuthError = { statusCode: HttpStatus.UNAUTHORIZED, code, message: MESSAGES[code] };
  return new UnauthorizedException(body);
}

export function forbidden(
  code: 'ACCOUNT_PENDING' | 'ACCOUNT_BLOCKED' | 'ACCOUNT_UNAVAILABLE' | 'ACCESS_DENIED' | 'CURRENT_PASSWORD_INVALID',
): ForbiddenException {
  const body: AuthError = { statusCode: HttpStatus.FORBIDDEN, code, message: MESSAGES[code] };
  return new ForbiddenException(body);
}
