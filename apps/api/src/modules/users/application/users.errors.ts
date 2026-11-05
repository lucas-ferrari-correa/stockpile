import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { UserError } from '@stockpile/shared';

const MESSAGES = {
  USER_NOT_FOUND: 'User not found',
  ROLE_NOT_FOUND: 'The selected role does not exist',
  INVALID_CURSOR: 'The cursor does not match any user',
  INVALID_TRANSITION: 'This action is not allowed for the current status of the user',
  SELF_ACTION_FORBIDDEN: 'You cannot perform this action on your own account',
  LAST_ADMIN_PROTECTED:
    'At least one active user must keep the users:manage and roles:manage permissions',
} as const satisfies Record<UserError['code'], string>;

export function userNotFound(): NotFoundException {
  const body: UserError = { statusCode: HttpStatus.NOT_FOUND, code: 'USER_NOT_FOUND', message: MESSAGES.USER_NOT_FOUND };
  return new NotFoundException(body);
}

export function roleNotFound(): UnprocessableEntityException {
  const body: UserError = {
    statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
    code: 'ROLE_NOT_FOUND',
    message: MESSAGES.ROLE_NOT_FOUND,
  };
  return new UnprocessableEntityException(body);
}

export function userConflict(
  code: 'INVALID_TRANSITION' | 'SELF_ACTION_FORBIDDEN' | 'LAST_ADMIN_PROTECTED',
): ConflictException {
  const body: UserError = { statusCode: HttpStatus.CONFLICT, code, message: MESSAGES[code] };
  return new ConflictException(body);
}

export function invalidCursor(): BadRequestException {
  const body: UserError = { statusCode: HttpStatus.BAD_REQUEST, code: 'INVALID_CURSOR', message: MESSAGES.INVALID_CURSOR };
  return new BadRequestException(body);
}
