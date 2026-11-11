import {
  duplicateImportErrorSchema,
  importAcceptedSchema,
  importDetailSchema,
  importErrorSchema,
  importIdParamSchema,
  importUploadQuerySchema,
  ratesUnavailableErrorSchema,
} from '@stockpile/shared';
import { createZodDto } from 'nestjs-zod';

export class ImportIdParamDto extends createZodDto(importIdParamSchema) {}

export class ImportUploadQueryDto extends createZodDto(importUploadQuerySchema) {}

export class ImportAcceptedDto extends createZodDto(importAcceptedSchema) {}

export class ImportDetailDto extends createZodDto(importDetailSchema) {}

export class ImportErrorDto extends createZodDto(importErrorSchema) {}

export class DuplicateImportErrorDto extends createZodDto(duplicateImportErrorSchema) {}

export class RatesUnavailableErrorDto extends createZodDto(ratesUnavailableErrorSchema) {}
