import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { UTCDate } from '@date-fns/utc';
import { faker } from '@faker-js/faker';
import currency from 'currency.js';
import { stringify } from 'csv-stringify/sync';
import { addDays, addYears, format } from 'date-fns';
import {
  classifyInventoryCells,
  INVENTORY_CSV_COLUMNS,
  INVENTORY_CSV_DELIMITER,
  inventoryIdentityKey,
  NUL_CHARACTER,
  SKU_MAX_LENGTH,
  type InventoryIdentity,
  type InventoryRejectionCode,
} from '../packages/shared/src/imports/contract';

interface Options {
  rows: number;
  seed: number;
  dirtyRatio: number;
  repeatIdentityRatio: number;
  out: string;
}

interface Manifest {
  seed: number;
  rows: number;
  total: number;
  dirtyRatio: number;
  repeatIdentityRatio: number;
  accepted: number;
  rejected: number;
  rejectedByReason: Record<InventoryRejectionCode, number>;
  distinctIdentities: number;
  expectedCreated: number;
  expectedUpdated: number;
}

interface Fields {
  sku: string;
  name: string;
  category: string;
  brand: string;
  supplier: string;
  country: string;
  warehouse: string;
  lot: string;
  quantity: string;
  unitCost: string;
  unitPrice: string;
  expiration: string;
}

interface Range {
  min: number;
  max: number;
}

interface Category {
  name: string;
  prefix: string;
  perishable: boolean;
  products: readonly string[];
  variants: readonly string[];
  cost: Range;
}

interface DirtyRow {
  cells: string[];
  code: InventoryRejectionCode;
  raw: boolean;
}

type DirtyClass = (fields: Fields) => DirtyRow;

type ExpirationBucket = 'none' | 'past' | 'soon' | 'distant';

type Margin = 'positive' | 'negative';

interface Weighted<T> {
  weight: number;
  value: T;
}

const REFERENCE_DATE = new UTCDate('2026-01-01T00:00:00.000Z');
const CALENDAR_DATE_FORMAT = 'M/d/yyyy';
const LOT_MONTH_FORMAT = 'yyyyMM';
const PAST_EXPIRATION_YEARS = 1;
const SOON_EXPIRATION_DAYS = 60;
const DISTANT_EXPIRATION_YEARS = 4;
const LOT_AGE_YEARS = 2;
const SKU_DIGITS = 6;
const LOT_DIGITS = 4;
const MAX_QUANTITY = 5000;
const IN_STOCK_PROBABILITY = 0.95;
const BRAND_PROBABILITY = 0.88;
const MONEY_SYMBOL_PROBABILITY = 0.3;
const CRLF_PROBABILITY = 0.1;
const NAUGHTY_EVERY = 25;
const MONEY_FRACTION_DIGITS = 2;
const MALFORMED_SCREEN_INCHES: Range = { min: 10, max: 99 };

const MARKUP: Record<Margin, Range> = {
  positive: { min: 1.1, max: 2 },
  negative: { min: 0.7, max: 0.98 },
};

const MARGIN_WEIGHTS: Weighted<Margin>[] = [
  { weight: 97, value: 'positive' },
  { weight: 3, value: 'negative' },
];

const PERISHABLE_EXPIRATION_WEIGHTS: Weighted<ExpirationBucket>[] = [
  { weight: 10, value: 'none' },
  { weight: 20, value: 'past' },
  { weight: 25, value: 'soon' },
  { weight: 45, value: 'distant' },
];

const DURABLE_EXPIRATION_WEIGHTS: Weighted<ExpirationBucket>[] = [
  { weight: 85, value: 'none' },
  { weight: 3, value: 'past' },
  { weight: 4, value: 'soon' },
  { weight: 8, value: 'distant' },
];

const CATEGORIES: readonly Category[] = [
  {
    name: 'Beverages',
    prefix: 'BEV',
    perishable: true,
    products: ['Sparkling Water', 'Orange Juice', 'Cold Brew Coffee', 'Green Tea', 'Coconut Water', 'Lemonade'],
    variants: ['330 ml', '500 ml', '1 L', '6-pack', '12-pack'],
    cost: { min: 0.4, max: 18 },
  },
  {
    name: 'Snacks',
    prefix: 'SNK',
    perishable: true,
    products: ['Sea Salt Chips', 'Trail Mix', 'Granola Bar', 'Rice Crackers', 'Dark Chocolate', 'Roasted Almonds'],
    variants: ['40 g', '150 g', '300 g', 'Family Size', 'Box of 12'],
    cost: { min: 0.6, max: 24 },
  },
  {
    name: 'Dairy',
    prefix: 'DAI',
    perishable: true,
    products: ['Greek Yogurt', 'Whole Milk', 'Cheddar Cheese', 'Butter', 'Cream Cheese', 'Kefir'],
    variants: ['200 g', '500 g', '1 L', '2 L'],
    cost: { min: 0.8, max: 16 },
  },
  {
    name: 'Bakery',
    prefix: 'BAK',
    perishable: true,
    products: ['Sourdough Loaf', 'Whole Wheat Bread', 'Croissant', 'Bagel', 'Tortilla Wraps'],
    variants: ['Single', 'Pack of 4', 'Pack of 6', '500 g'],
    cost: { min: 0.5, max: 9 },
  },
  {
    name: 'Frozen',
    prefix: 'FRZ',
    perishable: true,
    products: ['Mixed Vegetables', 'Pepperoni Pizza', 'Vanilla Ice Cream', 'Fish Fillets', 'Berry Mix'],
    variants: ['400 g', '1 kg', '2 kg', 'Party Size'],
    cost: { min: 1.5, max: 30 },
  },
  {
    name: 'Personal Care',
    prefix: 'PER',
    perishable: true,
    products: ['Shampoo', 'Body Wash', 'Toothpaste', 'Sunscreen SPF 50', 'Hand Cream', 'Deodorant'],
    variants: ['75 ml', '200 ml', '400 ml', 'Travel Kit'],
    cost: { min: 1.2, max: 26 },
  },
  {
    name: 'Pharmacy',
    prefix: 'PHA',
    perishable: true,
    products: ['Ibuprofen 200 mg', 'Vitamin C', 'Saline Spray', 'Antacid Tablets', 'Bandages'],
    variants: ['10 units', '30 units', '60 units', '100 units'],
    cost: { min: 1.5, max: 42 },
  },
  {
    name: 'Household',
    prefix: 'HOU',
    perishable: false,
    products: ['Dish Soap', 'Laundry Detergent', 'Paper Towels', 'Trash Bags', 'Glass Cleaner', 'Sponges'],
    variants: ['Small', 'Medium', 'Large', 'Refill', 'Bulk Pack'],
    cost: { min: 0.9, max: 35 },
  },
  {
    name: 'Electronics Accessories',
    prefix: 'ELA',
    perishable: false,
    products: ['USB-C Cable', 'Wireless Charger', 'Power Bank', 'Earbuds', 'HDMI Adapter', 'Phone Case'],
    variants: ['1 m', '2 m', '10000 mAh', 'Black', 'White'],
    cost: { min: 3, max: 90 },
  },
  {
    name: 'Pet Supplies',
    prefix: 'PET',
    perishable: true,
    products: ['Dry Dog Food', 'Cat Litter', 'Chew Toy', 'Wet Cat Food', 'Bird Seed'],
    variants: ['1 kg', '3 kg', '10 kg', 'Single', 'Pack of 12'],
    cost: { min: 1, max: 60 },
  },
];

const WAREHOUSES: readonly string[] = ['WH-SAO-01', 'WH-SAO-02', 'WH-RIO-01', 'WH-MIA-01', 'WH-LIS-01', 'WH-TOR-01', 'WH-MEX-01', 'WH-BOG-01'];

const BASELINE_FIELDS: Fields = {
  sku: 'BEV-000001',
  name: 'Sparkling Water 500 ml',
  category: 'Beverages',
  brand: 'Baseline',
  supplier: 'Baseline Supply',
  country: 'US',
  warehouse: 'WH-SAO-01',
  lot: 'L202601-0001',
  quantity: '1',
  unitCost: '1.00',
  unitPrice: '2.00',
  expiration: '',
};

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function loadNaughtyStrings(): readonly string[] {
  const list: unknown = createRequire(__filename)('big-list-of-naughty-strings');
  if (!isStringList(list)) {
    throw new Error('big-list-of-naughty-strings did not resolve to a list of strings');
  }
  return list.filter(
    (value) =>
      !value.includes('\r') &&
      !value.includes('\n') &&
      classifyInventoryCells(toCells(withField(BASELINE_FIELDS, 'name', value))).ok,
  );
}


function csvRecord(cells: readonly string[], recordDelimiter: string): string {
  return stringify([cells], { delimiter: INVENTORY_CSV_DELIMITER, record_delimiter: recordDelimiter });
}

function toCells(fields: Fields): string[] {
  return [
    fields.sku,
    fields.name,
    fields.category,
    fields.brand,
    fields.supplier,
    fields.country,
    fields.warehouse,
    fields.lot,
    fields.quantity,
    fields.unitCost,
    fields.unitPrice,
    fields.expiration,
  ];
}

function formatUtc(date: Date, pattern: string): string {
  return format(new UTCDate(date), pattern);
}

function formatMoney(amount: number): string {
  const symbol = faker.datatype.boolean({ probability: MONEY_SYMBOL_PROBABILITY }) ? '$' : '';
  return currency(amount).format({ symbol, separator: '' });
}

function expirationDate(bucket: ExpirationBucket): Date | null {
  switch (bucket) {
    case 'none':
      return null;
    case 'past':
      return faker.date.past({ years: PAST_EXPIRATION_YEARS });
    case 'soon':
      return faker.date.soon({ days: SOON_EXPIRATION_DAYS });
    case 'distant':
      return faker.date.between({
        from: addDays(REFERENCE_DATE, SOON_EXPIRATION_DAYS),
        to: addYears(REFERENCE_DATE, DISTANT_EXPIRATION_YEARS),
      });
  }
}

function expiration(category: Category): string {
  const weights = category.perishable ? PERISHABLE_EXPIRATION_WEIGHTS : DURABLE_EXPIRATION_WEIGHTS;
  const date = expirationDate(faker.helpers.weightedArrayElement(weights));
  return date ? formatUtc(date, CALENDAR_DATE_FORMAT) : '';
}

function freshIdentity(category: Category): InventoryIdentity {
  return {
    sku: `${category.prefix}-${faker.string.numeric({ length: SKU_DIGITS, allowLeadingZeros: true })}`,
    warehouse: faker.helpers.arrayElement(WAREHOUSES),
    lot: `L${formatUtc(faker.date.past({ years: LOT_AGE_YEARS }), LOT_MONTH_FORMAT)}-${faker.string.numeric({ length: LOT_DIGITS, allowLeadingZeros: true })}`,
  };
}

function categoryOfSku(sku: string): Category | undefined {
  return CATEGORIES.find((category) => sku.startsWith(`${category.prefix}-`));
}

function baseFields(identity: InventoryIdentity | null): Fields {
  const category = (identity ? categoryOfSku(identity.sku) : undefined) ?? faker.helpers.arrayElement(CATEGORIES);
  const resolvedIdentity = identity ?? freshIdentity(category);
  const cost = faker.number.float({ ...category.cost, fractionDigits: MONEY_FRACTION_DIGITS });
  const markup = faker.number.float({ ...MARKUP[faker.helpers.weightedArrayElement(MARGIN_WEIGHTS)], fractionDigits: MONEY_FRACTION_DIGITS });

  return {
    sku: resolvedIdentity.sku,
    name: `${faker.helpers.arrayElement(category.products)} ${faker.helpers.arrayElement(category.variants)}`,
    category: category.name,
    brand: faker.helpers.maybe(() => faker.person.lastName(), { probability: BRAND_PROBABILITY }) ?? '',
    supplier: faker.company.name(),
    country: faker.location.countryCode('alpha-2'),
    warehouse: resolvedIdentity.warehouse,
    lot: resolvedIdentity.lot,
    quantity: String(faker.helpers.maybe(() => faker.number.int({ min: 1, max: MAX_QUANTITY }), { probability: IN_STOCK_PROBABILITY }) ?? 0),
    unitCost: formatMoney(cost),
    unitPrice: formatMoney(currency(cost).multiply(markup).value),
    expiration: expiration(category),
  };
}

const REQUIRED_FIELD_KEYS: readonly (keyof Fields)[] = [
  'sku',
  'name',
  'category',
  'supplier',
  'country',
  'warehouse',
  'lot',
  'quantity',
  'unitCost',
  'unitPrice',
];

const TEXT_FIELD_KEYS: readonly (keyof Fields)[] = ['sku', 'name', 'category', 'brand', 'supplier', 'warehouse', 'lot'];

function withField(fields: Fields, key: keyof Fields, value: string): Fields {
  return { ...fields, [key]: value };
}

function rejected(fields: Fields, key: keyof Fields, value: string, code: InventoryRejectionCode): DirtyRow {
  return { cells: toCells(withField(fields, key, value)), code, raw: false };
}

const DIRTY_CLASSES: readonly DirtyClass[] = [
  (fields) => {
    const cells = toCells(fields);
    if (faker.datatype.boolean()) {
      cells.splice(faker.number.int({ min: 0, max: cells.length - 1 }), 1);
    } else {
      cells.push(faker.word.sample());
    }
    return { cells, code: 'COLUMN_COUNT', raw: false };
  },
  (fields) => ({
    cells: toCells(withField(fields, 'name', `${fields.name} ${faker.number.int(MALFORMED_SCREEN_INCHES)}" display`)),
    code: 'MALFORMED_ROW',
    raw: true,
  }),
  (fields) => rejected(fields, faker.helpers.arrayElement(REQUIRED_FIELD_KEYS), faker.helpers.arrayElement(['', ' ', '   ']), 'MISSING_FIELD'),
  (fields) =>
    rejected(
      fields,
      faker.helpers.arrayElement<keyof Fields>(['unitCost', 'unitPrice']),
      faker.helpers.arrayElement(['-1.00', '-$4.50', '12.345', '1,299.00', '12.5.1', 'free', '$', 'USD 10', '99999999.00']),
      'INVALID_MONEY',
    ),
  (fields) => rejected(fields, 'quantity', faker.helpers.arrayElement(['-3', '2.5', '1e3', 'ten', '2147483648', '+7', '0x10']), 'INVALID_QUANTITY'),
  (fields) => rejected(fields, 'country', faker.helpers.arrayElement(['XX', 'ZZ', 'us', 'br', 'USA', 'BRA', 'Brazil', '076']), 'INVALID_COUNTRY'),
  (fields) =>
    rejected(
      fields,
      'expiration',
      faker.helpers.arrayElement(['2/30/2027', '13/1/2027', '4/31/2026', '2/29/2027', '2027-03-15', '3/15/27', '0/10/2027', 'soon']),
      'INVALID_DATE',
    ),
  (fields) => {
    const key = faker.helpers.arrayElement(TEXT_FIELD_KEYS);
    const value = fields[key];
    const at = faker.number.int({ min: 0, max: value.length });
    return rejected(fields, key, `${value.slice(0, at)}${NUL_CHARACTER}${value.slice(at)}`, 'INVALID_CHARACTER');
  },
  (fields) =>
    rejected(fields, 'sku', faker.string.alphanumeric({ length: { min: SKU_MAX_LENGTH + 1, max: SKU_MAX_LENGTH * 2 } }), 'INVALID_LENGTH'),
];

function parseRatio(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`--${name} must be between 0 and 1`);
  }
  return value;
}

function parseOptions(argv: string[]): Options {
  const { values } = parseArgs({
    args: argv,
    options: {
      rows: { type: 'string', default: '2000' },
      seed: { type: 'string', default: '1' },
      'dirty-ratio': { type: 'string', default: '0.05' },
      'repeat-identity-ratio': { type: 'string', default: '0.1' },
      out: { type: 'string' },
    },
    strict: true,
  });
  const rows = Number(values.rows);
  const seed = Number(values.seed);
  if (!Number.isSafeInteger(rows) || rows < 0) {
    throw new Error('--rows must be a non-negative integer');
  }
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new Error('--seed must be a non-negative integer');
  }
  const out = values.out && values.out.length > 0 ? values.out : `data/fixtures/inventory-${rows}-${seed}.csv`;
  return {
    rows,
    seed,
    dirtyRatio: parseRatio('dirty-ratio', values['dirty-ratio']),
    repeatIdentityRatio: parseRatio('repeat-identity-ratio', values['repeat-identity-ratio']),
    out: resolve(out),
  };
}

function manifestPath(out: string): string {
  return `${out.endsWith('.csv') ? out.slice(0, -'.csv'.length) : out}.manifest.json`;
}

function emptyReasons(): Record<InventoryRejectionCode, number> {
  return {
    COLUMN_COUNT: 0,
    MALFORMED_ROW: 0,
    MISSING_FIELD: 0,
    INVALID_MONEY: 0,
    INVALID_QUANTITY: 0,
    INVALID_COUNTRY: 0,
    INVALID_DATE: 0,
    INVALID_CHARACTER: 0,
    INVALID_LENGTH: 0,
  };
}

async function write(stream: WriteStream, chunk: string): Promise<void> {
  if (!stream.write(chunk)) {
    await once(stream, 'drain');
  }
}

function serializeDirty(dirty: DirtyRow): string {
  if (dirty.raw) {
    return `${dirty.cells.join(INVENTORY_CSV_DELIMITER)}\n`;
  }
  const result = classifyInventoryCells(dirty.cells);
  if (result.ok || result.code !== dirty.code) {
    throw new Error(`Generated ${dirty.code} row classified as ${result.ok ? 'accepted' : result.code}`);
  }
  return csvRecord(dirty.cells, '\n');
}

async function generate(options: Options): Promise<Manifest> {
  const naughtyStrings = loadNaughtyStrings();
  if (naughtyStrings.length === 0) {
    throw new Error('No naughty string passes the inventory contract');
  }
  faker.seed(options.seed);
  faker.setDefaultRefDate(REFERENCE_DATE);
  const reasons = emptyReasons();
  const emitted: InventoryIdentity[] = [];
  const identities = new Set<string>();
  let accepted = 0;
  let rejectedCount = 0;
  let dirtyEmitted = 0;
  let validEmitted = 0;

  await mkdir(dirname(options.out), { recursive: true });
  const stream = createWriteStream(options.out, { encoding: 'utf8' });
  const finished = once(stream, 'finish');

  await write(stream, csvRecord(INVENTORY_CSV_COLUMNS, '\n'));
  for (let row = 0; row < options.rows; row += 1) {
    const isDirty = Math.floor((row + 1) * options.dirtyRatio) > Math.floor(row * options.dirtyRatio);
    const repeat =
      !isDirty && emitted.length > 0
        ? (faker.helpers.maybe(() => faker.helpers.arrayElement(emitted), { probability: options.repeatIdentityRatio }) ?? null)
        : null;
    const fields = baseFields(repeat);

    if (isDirty) {
      const dirtyClass = DIRTY_CLASSES[dirtyEmitted % DIRTY_CLASSES.length];
      if (!dirtyClass) {
        throw new Error('Dirty class catalog is empty');
      }
      const dirty = dirtyClass(fields);
      const line = serializeDirty(dirty);
      dirtyEmitted += 1;
      rejectedCount += 1;
      reasons[dirty.code] += 1;
      await write(stream, line);
      continue;
    }

    if ((validEmitted + 1) % NAUGHTY_EVERY === 0) {
      fields.name = faker.helpers.arrayElement(naughtyStrings);
    }
    const cells = toCells(fields);
    const result = classifyInventoryCells(cells);
    if (!result.ok) {
      throw new Error(`Generated valid row rejected as ${result.code}: ${result.message}`);
    }
    const identity: InventoryIdentity = { sku: result.row.sku, warehouse: result.row.warehouse, lot: result.row.lot };
    if (!repeat) {
      emitted.push(identity);
    }
    identities.add(inventoryIdentityKey(identity));
    validEmitted += 1;
    accepted += 1;
    await write(stream, csvRecord(cells, faker.datatype.boolean({ probability: CRLF_PROBABILITY }) ? '\r\n' : '\n'));
  }

  stream.end();
  await finished;

  const manifest: Manifest = {
    seed: options.seed,
    rows: options.rows,
    total: accepted + rejectedCount,
    dirtyRatio: options.dirtyRatio,
    repeatIdentityRatio: options.repeatIdentityRatio,
    accepted,
    rejected: rejectedCount,
    rejectedByReason: reasons,
    distinctIdentities: identities.size,
    expectedCreated: identities.size,
    expectedUpdated: accepted - identities.size,
  };
  await writeFile(manifestPath(options.out), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

generate(parseOptions(process.argv.slice(2)))
  .then((manifest) => {
    process.stdout.write(`${JSON.stringify(manifest)}\n`);
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
