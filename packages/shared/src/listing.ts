import { z } from 'zod';
import { NUL_CHARACTER, calendarDateSchema } from './imports/contract';

export const LISTING_SEARCH_MAX_LENGTH = 200;

export const LISTING_CURSOR_MAX_LENGTH = 1024;

export const LISTING_FILTER_MAX_VALUES = 50;

export const LISTING_LIMIT_DEFAULT = 50;

export const LISTING_LIMIT_MAX = 200;

export const TIME_ZONE_MAX_LENGTH = 64;

export const DEFAULT_TIME_ZONE = 'UTC';

export const sortOrderSchema = z.enum(['asc', 'desc']);

export type SortOrder = z.infer<typeof sortOrderSchema>;

export const listingSearchSchema = z
  .string()
  .max(LISTING_SEARCH_MAX_LENGTH)
  .refine((value) => !value.includes(NUL_CHARACTER), { message: 'Search must not contain NUL characters' })
  .transform((value) => value.trim())
  .transform((value) => (value.length === 0 ? undefined : value));

export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const timeZoneSchema = z
  .string()
  .min(1)
  .max(TIME_ZONE_MAX_LENGTH)
  .refine(isTimeZone, { message: 'tz must be an IANA time zone, for example America/New_York' });

export const listingCursorSchema = z.base64url().min(1).max(LISTING_CURSOR_MAX_LENGTH);

export const listingFilterTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(LISTING_SEARCH_MAX_LENGTH)
  .refine((value) => !value.includes(NUL_CHARACTER), { message: 'Filter values must not contain NUL characters' });

export function listingLimitSchema(max: number, fallback: number): z.ZodDefault<z.ZodCoercedNumber<unknown>> {
  return z.coerce.number().int().min(1).max(max).default(fallback);
}

export function listingFilterValues<T extends z.ZodType>(schema: T): z.ZodType<Array<z.output<T>>, unknown> {
  return z
    .union([schema, z.array(schema).min(1).max(LISTING_FILTER_MAX_VALUES)])
    .transform((value: z.output<T> | Array<z.output<T>>): Array<z.output<T>> => (Array.isArray(value) ? value : [value]));
}

export interface CreatedRange {
  createdFrom?: string;
  createdTo?: string;
}

export function refineCreatedRange(query: CreatedRange, ctx: z.RefinementCtx): void {
  if (query.createdFrom !== undefined && query.createdTo !== undefined && query.createdFrom > query.createdTo) {
    ctx.addIssue({ code: 'custom', path: ['createdTo'], message: 'createdTo must be on or after createdFrom' });
  }
}

export const listingQuerySchema = z.object({
  q: listingSearchSchema.optional(),
  sort: z.string().min(1).optional(),
  order: sortOrderSchema.default('asc'),
  limit: listingLimitSchema(LISTING_LIMIT_MAX, LISTING_LIMIT_DEFAULT),
  cursor: listingCursorSchema.optional(),
  tz: timeZoneSchema.default(DEFAULT_TIME_ZONE),
  createdFrom: calendarDateSchema.optional(),
  createdTo: calendarDateSchema.optional(),
});

export interface ListingQuery<S extends string = string> {
  q?: string | undefined;
  sort: S;
  order: SortOrder;
  limit: number;
  cursor?: string | undefined;
  tz: string;
  createdFrom?: string | undefined;
  createdTo?: string | undefined;
}

export type FilterParam<T> = T | readonly T[];

export interface ListingQueryParams<S extends string = string> {
  q?: string;
  sort?: S;
  order?: SortOrder;
  limit?: number;
  cursor?: string;
  tz?: string;
  createdFrom?: string;
  createdTo?: string;
}

export const listingErrorCodeSchema = z.enum(['INVALID_CURSOR']);

export type ListingErrorCode = z.infer<typeof listingErrorCodeSchema>;
