import currency from 'currency.js';
import { getAlpha2Codes } from 'i18n-iso-countries';
import isCurrency, { type IsCurrencyOptions } from 'validator/lib/isCurrency';
import isNumeric from 'validator/lib/isNumeric';
import { z } from 'zod';

export const INVENTORY_CSV_COLUMNS = [
  'sku',
  'name',
  'category',
  'brand',
  'supplier',
  'country',
  'warehouse',
  'lot',
  'quantity',
  'unit_cost',
  'unit_price',
  'expiration',
] as const;

export type InventoryCsvColumn = (typeof INVENTORY_CSV_COLUMNS)[number];

export const INVENTORY_CSV_DELIMITER = ';';

export const INVENTORY_CSV_HEADER = INVENTORY_CSV_COLUMNS.join(INVENTORY_CSV_DELIMITER);

export const SKU_MAX_LENGTH = 64;

export const NUL_CHARACTER = '\u0000';

export const inventoryRejectionCodeSchema = z.enum([
  'COLUMN_COUNT',
  'MALFORMED_ROW',
  'MISSING_FIELD',
  'INVALID_MONEY',
  'INVALID_QUANTITY',
  'INVALID_COUNTRY',
  'INVALID_DATE',
  'INVALID_CHARACTER',
  'INVALID_LENGTH',
]);

export type InventoryRejectionCode = z.infer<typeof inventoryRejectionCodeSchema>;

export const INVENTORY_REJECTION_CODES: readonly InventoryRejectionCode[] = inventoryRejectionCodeSchema.options;

const ISO_ALPHA2_CODES: ReadonlySet<string> = new Set(Object.keys(getAlpha2Codes()));

const MONEY_FORMAT_OPTIONS: IsCurrencyOptions = {
  symbol: '$',
  require_symbol: false,
  allow_negatives: false,
  digits_after_decimal: [0, 1, 2],
  thousands_separator: NUL_CHARACTER,
};

export const calendarDateSchema = z.iso.date();

export type CalendarDate = z.infer<typeof calendarDateSchema>;

const requiredTextSchema = z.string().trim().min(1);

export const skuSchema = requiredTextSchema.max(SKU_MAX_LENGTH);

export const brandSchema = z
  .string()
  .trim()
  .transform((value) => (value.length === 0 ? null : value));

export const countryCodeSchema = z
  .string()
  .trim()
  .refine((value) => ISO_ALPHA2_CODES.has(value), { message: 'Country must be an upper case ISO 3166-1 alpha-2 code' });

export const quantitySchema = z
  .string()
  .trim()
  .refine((value) => isNumeric(value, { no_symbols: true }), { message: 'Quantity must be a non-negative integer' })
  .transform(Number)
  .pipe(z.int32({ message: 'Quantity exceeds the supported maximum' }).nonnegative());

export const moneyCentsSchema = z
  .string()
  .trim()
  .refine((value) => isCurrency(value, MONEY_FORMAT_OPTIONS), { message: 'Amount must be a non-negative USD value with up to 2 decimals' })
  .transform((value) => currency(value).intValue)
  .pipe(z.int32({ message: 'Amount exceeds the supported maximum' }).nonnegative());

export const expirationSchema = z
  .string()
  .trim()
  .transform((value, ctx) => {
    if (value.length === 0) {
      return null;
    }

    const [month = '', day = '', year = '', ...rest] = value.split('/');
    if (rest.length > 0 || month.length > 2 || day.length > 2 || year.length !== 4) {
      ctx.addIssue({ code: 'custom', message: 'Expiration must use the M/D/YYYY format' });
      return z.NEVER;
    }

    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  })
  .pipe(calendarDateSchema.nullable());

export const inventoryRowSchema = z.object({
  sku: skuSchema,
  name: requiredTextSchema,
  category: requiredTextSchema,
  brand: brandSchema,
  supplier: requiredTextSchema,
  country: countryCodeSchema,
  warehouse: requiredTextSchema,
  lot: requiredTextSchema,
  quantity: quantitySchema,
  unit_cost: moneyCentsSchema,
  unit_price: moneyCentsSchema,
  expiration: expirationSchema,
});

export type InventoryCsvRecord = z.input<typeof inventoryRowSchema>;

export type InventoryRow = z.output<typeof inventoryRowSchema>;

const OPTIONAL_COLUMNS: ReadonlySet<InventoryCsvColumn> = new Set<InventoryCsvColumn>(['brand', 'expiration']);

const INVALID_CODE_BY_COLUMN: Record<InventoryCsvColumn, InventoryRejectionCode> = {
  sku: 'INVALID_LENGTH',
  name: 'MISSING_FIELD',
  category: 'MISSING_FIELD',
  brand: 'MISSING_FIELD',
  supplier: 'MISSING_FIELD',
  country: 'INVALID_COUNTRY',
  warehouse: 'MISSING_FIELD',
  lot: 'MISSING_FIELD',
  quantity: 'INVALID_QUANTITY',
  unit_cost: 'INVALID_MONEY',
  unit_price: 'INVALID_MONEY',
  expiration: 'INVALID_DATE',
};

export interface InventoryRowAccepted {
  ok: true;
  row: InventoryRow;
}

export interface InventoryRowRejected {
  ok: false;
  field: InventoryCsvColumn | null;
  code: InventoryRejectionCode;
  message: string;
}

export type InventoryRowResult = InventoryRowAccepted | InventoryRowRejected;

function isInventoryCsvColumn(value: unknown): value is InventoryCsvColumn {
  return typeof value === 'string' && (INVENTORY_CSV_COLUMNS as readonly string[]).includes(value);
}

export function isInventoryCsvHeader(cells: readonly string[]): boolean {
  return cells.length === INVENTORY_CSV_COLUMNS.length && INVENTORY_CSV_COLUMNS.every((column, index) => cells[index] === column);
}

export function classifyInventoryCells(cells: readonly string[]): InventoryRowResult {
  if (cells.length !== INVENTORY_CSV_COLUMNS.length) {
    return {
      ok: false,
      field: null,
      code: 'COLUMN_COUNT',
      message: `Expected ${INVENTORY_CSV_COLUMNS.length} columns but found ${cells.length}`,
    };
  }

  const [
    sku = '',
    name = '',
    category = '',
    brand = '',
    supplier = '',
    country = '',
    warehouse = '',
    lot = '',
    quantity = '',
    unit_cost = '',
    unit_price = '',
    expiration = '',
  ] = cells;
  const record: Record<InventoryCsvColumn, string> = {
    sku,
    name,
    category,
    brand,
    supplier,
    country,
    warehouse,
    lot,
    quantity,
    unit_cost,
    unit_price,
    expiration,
  };

  for (const column of INVENTORY_CSV_COLUMNS) {
    if (record[column].includes(NUL_CHARACTER)) {
      return { ok: false, field: column, code: 'INVALID_CHARACTER', message: `${column} must not contain the NUL character` };
    }
  }

  for (const column of INVENTORY_CSV_COLUMNS) {
    if (!OPTIONAL_COLUMNS.has(column) && record[column].trim().length === 0) {
      return { ok: false, field: column, code: 'MISSING_FIELD', message: `${column} is required` };
    }
  }

  const parsed = inventoryRowSchema.safeParse(record);
  if (parsed.success) {
    return { ok: true, row: parsed.data };
  }

  const issues = parsed.error.issues
    .map((issue) => ({ issue, column: issue.path[0] }))
    .filter((entry): entry is { issue: z.core.$ZodIssue; column: InventoryCsvColumn } => isInventoryCsvColumn(entry.column))
    .sort((left, right) => INVENTORY_CSV_COLUMNS.indexOf(left.column) - INVENTORY_CSV_COLUMNS.indexOf(right.column));

  const first = issues[0];
  if (!first) {
    return { ok: false, field: null, code: 'MALFORMED_ROW', message: parsed.error.message };
  }

  return { ok: false, field: first.column, code: INVALID_CODE_BY_COLUMN[first.column], message: `${first.column}: ${first.issue.message}` };
}

export interface InventoryIdentity {
  sku: string;
  warehouse: string;
  lot: string;
}

export function inventoryIdentityKey(identity: InventoryIdentity): string {
  return JSON.stringify([identity.sku, identity.warehouse, identity.lot]);
}
