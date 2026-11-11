import { z } from 'zod';
import { calendarDateSchema } from './contract';

export const IMPORT_FILE_FIELD = 'file';

export const importStatusSchema = z.enum(['pending', 'processing', 'completed', 'failed']);

export type ImportStatus = z.infer<typeof importStatusSchema>;

export const importIdParamSchema = z.object({
  id: z.uuid(),
});

export type ImportIdParam = z.infer<typeof importIdParamSchema>;

export const importAcceptedSchema = z.object({
  importId: z.uuid(),
});

export type ImportAccepted = z.infer<typeof importAcceptedSchema>;

export const importUploadQuerySchema = z.object({
  force: z.stringbool().default(false),
});

export type ImportUploadQuery = z.infer<typeof importUploadQuerySchema>;

export const rejectedByReasonSchema = z.record(z.string(), z.number().int().nonnegative());

export type RejectedByReason = z.infer<typeof rejectedByReasonSchema>;

export const importRatesSchema = z.object({
  date: calendarDateSchema,
  base: z.string(),
});

export type ImportRates = z.infer<typeof importRatesSchema>;

export const importDetailSchema = z.object({
  id: z.uuid(),
  status: importStatusSchema,
  fileName: z.string(),
  totalRows: z.number().int().nonnegative().nullable(),
  processedRows: z.number().int().nonnegative(),
  acceptedRows: z.number().int().nonnegative(),
  rejectedRows: z.number().int().nonnegative(),
  rejectedByReason: rejectedByReasonSchema,
  failureReason: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  rates: importRatesSchema.nullable(),
});

export type ImportDetail = z.infer<typeof importDetailSchema>;

export const importErrorCodeSchema = z.enum([
  'IMPORT_NOT_FOUND',
  'FILE_REQUIRED',
  'INVALID_FILE_TYPE',
  'INVALID_MULTIPART',
  'FILE_TOO_LARGE',
  'DUPLICATE_IMPORT',
  'RATES_UNAVAILABLE',
]);

export type ImportErrorCode = z.infer<typeof importErrorCodeSchema>;

export const importErrorSchema = z.object({
  statusCode: z.number().int(),
  code: importErrorCodeSchema,
  message: z.string(),
});

export type ImportError = z.infer<typeof importErrorSchema>;

export const duplicateImportErrorSchema = z.object({
  statusCode: z.literal(409),
  code: z.literal('DUPLICATE_IMPORT'),
  message: z.string(),
  existingImportId: z.uuid(),
});

export type DuplicateImportError = z.infer<typeof duplicateImportErrorSchema>;

export const ratesUnavailableErrorSchema = z.object({
  statusCode: z.literal(503),
  code: z.literal('RATES_UNAVAILABLE'),
  message: z.string(),
  importId: z.uuid(),
});

export type RatesUnavailableError = z.infer<typeof ratesUnavailableErrorSchema>;

export * from './contract';
