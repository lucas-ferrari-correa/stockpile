import { BadRequestException, ConflictException, HttpStatus } from '@nestjs/common';
import { StockItemsError } from '@stockpile/shared';

const MESSAGES = {
  INVALID_CURSOR: 'The cursor is malformed or does not match the requested sort and order',
  IMPORT_NOT_COMPLETED: 'The import has not completed yet',
} as const satisfies Record<StockItemsError['code'], string>;

export function invalidCursor(): BadRequestException {
  const body: StockItemsError = {
    statusCode: HttpStatus.BAD_REQUEST,
    code: 'INVALID_CURSOR',
    message: MESSAGES.INVALID_CURSOR,
  };
  return new BadRequestException(body);
}

export function importNotCompleted(): ConflictException {
  const body: StockItemsError = {
    statusCode: HttpStatus.CONFLICT,
    code: 'IMPORT_NOT_COMPLETED',
    message: MESSAGES.IMPORT_NOT_COMPLETED,
  };
  return new ConflictException(body);
}
