import { ConflictException, HttpStatus, NotFoundException } from '@nestjs/common';
import { RoleError } from '@stockpile/shared';

const MESSAGES = {
  ROLE_NOT_FOUND: 'Role not found',
  ROLE_NAME_TAKEN: 'A role with this name already exists',
  ROLE_IN_USE: 'The role is assigned to users and cannot be deleted',
  SYSTEM_ROLE_IMMUTABLE: 'System roles cannot be changed or deleted',
  LAST_ADMIN_PROTECTED:
    'At least one active user must keep the users:manage and roles:manage permissions',
} as const satisfies Record<RoleError['code'], string>;

export function roleNotFound(): NotFoundException {
  const body: RoleError = { statusCode: HttpStatus.NOT_FOUND, code: 'ROLE_NOT_FOUND', message: MESSAGES.ROLE_NOT_FOUND };
  return new NotFoundException(body);
}

export function roleConflict(
  code: 'ROLE_NAME_TAKEN' | 'SYSTEM_ROLE_IMMUTABLE' | 'LAST_ADMIN_PROTECTED',
): ConflictException {
  const body: RoleError = { statusCode: HttpStatus.CONFLICT, code, message: MESSAGES[code] };
  return new ConflictException(body);
}

export function roleInUse(userCount: number): ConflictException {
  const body: RoleError = {
    statusCode: HttpStatus.CONFLICT,
    code: 'ROLE_IN_USE',
    message: MESSAGES.ROLE_IN_USE,
    userCount,
  };
  return new ConflictException(body);
}
