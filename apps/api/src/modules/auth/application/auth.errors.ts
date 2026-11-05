import { ForbiddenException, HttpStatus, UnauthorizedException } from '@nestjs/common';
import { AuthError } from '@stockpile/shared';

const MESSAGES = {
  UNAUTHENTICATED: 'Authentication is required',
  INVALID_CREDENTIALS: 'Invalid email or password',
  ACCOUNT_PENDING: 'Your account is awaiting approval by an administrator',
  ACCOUNT_BLOCKED: 'Your account has been blocked',
  ACCESS_DENIED: 'You do not have permission to access this resource',
} as const satisfies Record<AuthError['code'], string>;

export function unauthorized(code: 'UNAUTHENTICATED' | 'INVALID_CREDENTIALS'): UnauthorizedException {
  const body: AuthError = { statusCode: HttpStatus.UNAUTHORIZED, code, message: MESSAGES[code] };
  return new UnauthorizedException(body);
}

export function forbidden(code: 'ACCOUNT_PENDING' | 'ACCOUNT_BLOCKED' | 'ACCESS_DENIED'): ForbiddenException {
  const body: AuthError = { statusCode: HttpStatus.FORBIDDEN, code, message: MESSAGES[code] };
  return new ForbiddenException(body);
}
