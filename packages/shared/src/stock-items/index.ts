import { z } from 'zod';
import { calendarDateSchema, countryCodeSchema, moneyCentsSchema } from '../imports/contract';
import {
  LISTING_LIMIT_DEFAULT,
  LISTING_LIMIT_MAX,
  listingFilterTextSchema,
  listingFilterValues,
  listingLimitSchema,
  listingQuerySchema,
  refineCreatedRange,
  sortOrderSchema,
  type FilterParam,
  type ListingQueryParams,
} from '../listing';

export const STOCK_ITEM_SORTS = [
  'sku',
  'name',
  'category',
  'warehouse',
  'quantity',
  'unitCost',
  'unitPrice',
  'margin',
  'expiration',
] as const;

export const stockItemSortSchema = z.enum(STOCK_ITEM_SORTS);

export type StockItemSort = z.infer<typeof stockItemSortSchema>;

export const STOCK_ITEMS_DEFAULT_SORT: StockItemSort = 'sku';

const quantityBoundSchema = z.coerce.number().pipe(z.int32().nonnegative());

export const stockItemsQuerySchema = listingQuerySchema
  .extend({
    sort: stockItemSortSchema.default(STOCK_ITEMS_DEFAULT_SORT),
    order: sortOrderSchema.default('asc'),
    limit: listingLimitSchema(LISTING_LIMIT_MAX, LISTING_LIMIT_DEFAULT),
    importId: z.uuid().optional(),
    category: listingFilterValues(listingFilterTextSchema).optional(),
    brand: listingFilterValues(listingFilterTextSchema).optional(),
    supplier: listingFilterValues(listingFilterTextSchema).optional(),
    country: listingFilterValues(countryCodeSchema).optional(),
    warehouse: listingFilterValues(listingFilterTextSchema).optional(),
    minPrice: moneyCentsSchema.optional(),
    maxPrice: moneyCentsSchema.optional(),
    minCost: moneyCentsSchema.optional(),
    maxCost: moneyCentsSchema.optional(),
    minQuantity: quantityBoundSchema.optional(),
    maxQuantity: quantityBoundSchema.optional(),
    expiresFrom: calendarDateSchema.optional(),
    expiresTo: calendarDateSchema.optional(),
    expiration: z.literal('none').optional(),
  })
  .superRefine((query, ctx) => {
    const ranges: Array<[keyof typeof query, number | string | undefined, number | string | undefined, string]> = [
      ['maxPrice', query.minPrice, query.maxPrice, 'maxPrice must be greater than or equal to minPrice'],
      ['maxCost', query.minCost, query.maxCost, 'maxCost must be greater than or equal to minCost'],
      ['maxQuantity', query.minQuantity, query.maxQuantity, 'maxQuantity must be greater than or equal to minQuantity'],
      ['expiresTo', query.expiresFrom, query.expiresTo, 'expiresTo must be on or after expiresFrom'],
    ];
    for (const [path, min, max, message] of ranges) {
      if (min !== undefined && max !== undefined && min > max) {
        ctx.addIssue({ code: 'custom', path: [path], message });
      }
    }
    if (query.expiration === 'none' && (query.expiresFrom !== undefined || query.expiresTo !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['expiration'],
        message: 'expiration=none cannot be combined with expiresFrom or expiresTo',
      });
    }
    refineCreatedRange(query, ctx);
  });

export type StockItemsQuery = z.infer<typeof stockItemsQuerySchema>;

export interface StockItemsQueryParams extends ListingQueryParams<StockItemSort> {
  importId?: string;
  category?: FilterParam<string>;
  brand?: FilterParam<string>;
  supplier?: FilterParam<string>;
  country?: FilterParam<string>;
  warehouse?: FilterParam<string>;
  minPrice?: string;
  maxPrice?: string;
  minCost?: string;
  maxCost?: string;
  minQuantity?: number;
  maxQuantity?: number;
  expiresFrom?: string;
  expiresTo?: string;
  expiration?: 'none';
}

export const stockItemConversionSchema = z.object({
  currency: z.string(),
  rate: z.number().positive(),
  unitCostCents: z.number().int().nonnegative(),
  unitPriceCents: z.number().int().nonnegative(),
});

export type StockItemConversion = z.infer<typeof stockItemConversionSchema>;

export const stockItemRatesSchema = z.object({
  base: z.string(),
  date: calendarDateSchema,
  source: z.string(),
});

export type StockItemRates = z.infer<typeof stockItemRatesSchema>;

export const stockItemSchema = z.object({
  id: z.number().int().positive(),
  importId: z.uuid(),
  sku: z.string(),
  name: z.string(),
  category: z.string(),
  brand: z.string().nullable(),
  supplier: z.string(),
  country: z.string(),
  warehouse: z.string(),
  lot: z.string(),
  quantity: z.number().int().nonnegative(),
  unitCostCents: z.number().int().nonnegative(),
  unitPriceCents: z.number().int().nonnegative(),
  marginCents: z.number().int(),
  expiration: calendarDateSchema.nullable(),
  rates: stockItemRatesSchema.nullable(),
  conversions: z.array(stockItemConversionSchema),
});

export type StockItem = z.infer<typeof stockItemSchema>;

export const stockItemPageSchema = z.object({
  items: z.array(stockItemSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().nonnegative().nullable(),
});

export type StockItemPage = z.infer<typeof stockItemPageSchema>;

export const stockItemsErrorCodeSchema = z.enum(['INVALID_CURSOR', 'IMPORT_NOT_COMPLETED']);

export type StockItemsErrorCode = z.infer<typeof stockItemsErrorCodeSchema>;

export const stockItemsErrorSchema = z.object({
  statusCode: z.number().int(),
  code: stockItemsErrorCodeSchema,
  message: z.string(),
});

export type StockItemsError = z.infer<typeof stockItemsErrorSchema>;
