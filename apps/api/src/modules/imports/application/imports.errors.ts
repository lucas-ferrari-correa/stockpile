import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DuplicateImportError, ImportError, RatesUnavailableError } from '@stockpile/shared';

export const IMPORT_INTERRUPTED_REASON = 'IMPORT_INTERRUPTED: The upload stopped before the exchange rates were captured';

export const IMPORT_FILE_MISSING_REASON = 'IMPORT_FILE_MISSING: The uploaded file is no longer available for processing';

const MESSAGES = {
  IMPORT_NOT_FOUND: 'Import not found',
  FILE_REQUIRED: 'A CSV file is required in the "file" field',
  INVALID_FILE_TYPE: 'Only files with the .csv extension are accepted',
  INVALID_MULTIPART: 'The request must be a valid multipart/form-data upload',
  FILE_TOO_LARGE: 'The uploaded file exceeds the maximum allowed size',
  DUPLICATE_IMPORT: 'This file was already imported',
  RATES_UNAVAILABLE: 'The exchange rates could not be captured, the import was marked as failed',
} as const satisfies Record<ImportError['code'], string>;

export function importNotFound(): NotFoundException {
  const body: ImportError = { statusCode: HttpStatus.NOT_FOUND, code: 'IMPORT_NOT_FOUND', message: MESSAGES.IMPORT_NOT_FOUND };
  return new NotFoundException(body);
}

export function invalidUpload(code: 'FILE_REQUIRED' | 'INVALID_FILE_TYPE' | 'INVALID_MULTIPART'): BadRequestException {
  const body: ImportError = { statusCode: HttpStatus.BAD_REQUEST, code, message: MESSAGES[code] };
  return new BadRequestException(body);
}

export function fileTooLarge(): PayloadTooLargeException {
  const body: ImportError = { statusCode: HttpStatus.PAYLOAD_TOO_LARGE, code: 'FILE_TOO_LARGE', message: MESSAGES.FILE_TOO_LARGE };
  return new PayloadTooLargeException(body);
}

export function duplicateImport(existingImportId: string): ConflictException {
  const body: DuplicateImportError = {
    statusCode: HttpStatus.CONFLICT,
    code: 'DUPLICATE_IMPORT',
    message: MESSAGES.DUPLICATE_IMPORT,
    existingImportId,
  };
  return new ConflictException(body);
}

export function ratesUnavailable(importId: string): ServiceUnavailableException {
  const body: RatesUnavailableError = {
    statusCode: HttpStatus.SERVICE_UNAVAILABLE,
    code: 'RATES_UNAVAILABLE',
    message: MESSAGES.RATES_UNAVAILABLE,
    importId,
  };
  return new ServiceUnavailableException(body);
}

export function failureReason(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const code: unknown = Reflect.get(error, 'code');
  return typeof code === 'string' ? `${code}: ${error.message}` : error.message;
}
