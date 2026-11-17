import { createRequire } from 'node:module';
import { InventoryCsvColumn, InventoryRejectionCode, NUL_CHARACTER, SKU_MAX_LENGTH, classifyInventoryCells } from '@stockpile/shared';
import fc from 'fast-check';
import { z } from 'zod';
import { PrismaService } from '../../src/infra/prisma/prisma.service';
import { ImportsHarness, SeededUser } from '../support/imports-harness';
import {
  Eol,
  ExpectedItem,
  ExpectedRejection,
  InventoryCells,
  LabeledCsv,
  LabeledLine,
  LabeledRow,
  buildLabeledCsv,
  cellsOf,
  csvRecord,
  identityOrder,
} from './labeled-csv';

const INT32_MAX = 2147483647;
const PROPERTY_SEED = 20261117;
const PROPERTY_RUNS = 100;
const PROPERTY_TIMEOUT_MS = 600000;
const EOLS: readonly Eol[] = ['\n', '\r\n', '\r'];
const REQUIRED_COLUMNS: readonly InventoryCsvColumn[] = ['sku', 'name', 'category', 'supplier', 'country', 'warehouse', 'lot', 'quantity', 'unit_cost', 'unit_price'];
const ALL_COLUMNS: readonly InventoryCsvColumn[] = [...REQUIRED_COLUMNS, 'brand', 'expiration'];

const BASE_CELLS: InventoryCells = {
  sku: 'BASE',
  name: 'Base widget',
  category: 'Tools',
  brand: 'Acme',
  supplier: 'Supplier Co',
  country: 'US',
  warehouse: 'WH-1',
  lot: 'LOT-1',
  quantity: '5',
  unit_cost: '1.25',
  unit_price: '2.50',
  expiration: '3/4/2030',
};

const BASE_ITEM: ExpectedItem = {
  sku: 'BASE',
  name: 'Base widget',
  category: 'Tools',
  brand: 'Acme',
  supplier: 'Supplier Co',
  country: 'US',
  warehouse: 'WH-1',
  lot: 'LOT-1',
  quantity: 5,
  unitCostCents: 125,
  unitPriceCents: 250,
  expiration: '2030-03-04',
};

const storedItemSchema = z.object({
  sku: z.string(),
  name: z.string(),
  category: z.string(),
  brand: z.string().nullable(),
  supplier: z.string(),
  country: z.string(),
  warehouse: z.string(),
  lot: z.string(),
  quantity: z.number().int(),
  unitCostCents: z.number().int(),
  unitPriceCents: z.number().int(),
  expiration: z.string().nullable(),
});

function accepted(sku: string, cells: Partial<InventoryCells>, item: Partial<ExpectedItem>): LabeledRow {
  return { expected: 'accepted', record: csvRecord(cellsOf({ ...BASE_CELLS, ...cells, sku })), item: { ...BASE_ITEM, ...item, sku: item.sku ?? sku } };
}

function rejected(sku: string, cells: Partial<InventoryCells>, code: InventoryRejectionCode, field: InventoryCsvColumn | null): LabeledRow {
  return { expected: code, record: csvRecord(cellsOf({ ...BASE_CELLS, sku, ...cells })), field };
}

function rawRejected(record: string, code: InventoryRejectionCode): LabeledRow {
  return { expected: code, record, field: null };
}

function lines(rows: readonly LabeledRow[], eols: readonly Eol[] = ['\n']): LabeledLine[] {
  return rows.map((row, index) => ({ row, eol: eols[index % eols.length] ?? '\n' }));
}

function loadNaughtyStrings(): string[] {
  const list = z.array(z.string()).parse(createRequire(__filename)('big-list-of-naughty-strings'));
  return list.filter((value) => classifyInventoryCells(cellsOf({ ...BASE_CELLS, name: value })).ok);
}

async function storedCatalog(prisma: PrismaService): Promise<ExpectedItem[]> {
  const rows = await prisma.$queryRaw<unknown[]>`
    SELECT sku, name, category, brand, supplier, country, warehouse, lot, quantity,
      unit_cost_cents AS "unitCostCents", unit_price_cents AS "unitPriceCents", expiration::text AS expiration
    FROM stock_items
  `;
  return z.array(storedItemSchema).parse(rows).sort(identityOrder);
}

interface ImportOutcome {
  counters: {
    totalRows: number | null;
    acceptedRows: number;
    rejectedRows: number;
    rejectedByReason: unknown;
    itemCount: number;
    itemsCreated: number;
    itemsUpdated: number;
  };
  errors: ExpectedRejection[];
  catalog: ExpectedItem[];
}

const storedErrorSchema = z.object({
  line: z.number().int(),
  field: z.enum(['sku', 'name', 'category', 'brand', 'supplier', 'country', 'warehouse', 'lot', 'quantity', 'unit_cost', 'unit_price', 'expiration']).nullable(),
  code: z.enum(['COLUMN_COUNT', 'MALFORMED_ROW', 'MISSING_FIELD', 'INVALID_MONEY', 'INVALID_QUANTITY', 'INVALID_COUNTRY', 'INVALID_DATE', 'INVALID_CHARACTER', 'INVALID_LENGTH']),
  raw: z.string(),
});

async function outcomeOf(prisma: PrismaService, importId: string): Promise<ImportOutcome> {
  const counters = await prisma.import.findUniqueOrThrow({
    where: { id: importId },
    select: { totalRows: true, acceptedRows: true, rejectedRows: true, rejectedByReason: true, itemCount: true, itemsCreated: true, itemsUpdated: true },
  });
  const errors = await prisma.importError.findMany({
    where: { importId },
    orderBy: { line: 'asc' },
    select: { line: true, field: true, code: true, raw: true },
  });
  return { counters, errors: z.array(storedErrorSchema).parse(errors), catalog: await storedCatalog(prisma) };
}

function expectedOutcome(csv: LabeledCsv): ImportOutcome {
  return {
    counters: {
      totalRows: csv.total,
      acceptedRows: csv.acceptedRows,
      rejectedRows: csv.rejections.length,
      rejectedByReason: csv.rejectedByReason,
      itemCount: csv.catalog.length,
      itemsCreated: csv.catalog.length,
      itemsUpdated: 0,
    },
    errors: csv.rejections,
    catalog: csv.catalog,
  };
}

const MUTATIONS: ReadonlyArray<[string, LabeledRow]> = [
  ['an empty sku', rejected('', {}, 'MISSING_FIELD', 'sku')],
  ['a sku one character above the limit', rejected('S'.repeat(SKU_MAX_LENGTH + 1), {}, 'INVALID_LENGTH', 'sku')],
  ['a NUL inside the sku', rejected(`M-SKU${NUL_CHARACTER}`, {}, 'INVALID_CHARACTER', 'sku')],
  ['a blank name', rejected('M-NAME-BLANK', { name: '   ' }, 'MISSING_FIELD', 'name')],
  ['a NUL inside the name', rejected('M-NAME-NUL', { name: `bad${NUL_CHARACTER}name` }, 'INVALID_CHARACTER', 'name')],
  ['an empty category', rejected('M-CATEGORY', { category: '' }, 'MISSING_FIELD', 'category')],
  ['a NUL inside the category', rejected('M-CATEGORY-NUL', { category: `T${NUL_CHARACTER}` }, 'INVALID_CHARACTER', 'category')],
  ['a NUL inside the brand', rejected('M-BRAND-NUL', { brand: NUL_CHARACTER }, 'INVALID_CHARACTER', 'brand')],
  ['an empty supplier', rejected('M-SUPPLIER', { supplier: '' }, 'MISSING_FIELD', 'supplier')],
  ['an empty country', rejected('M-COUNTRY-EMPTY', { country: '' }, 'MISSING_FIELD', 'country')],
  ['a lower case country', rejected('M-COUNTRY-LOWER', { country: 'br' }, 'INVALID_COUNTRY', 'country')],
  ['a three letter country', rejected('M-COUNTRY-ALPHA3', { country: 'USA' }, 'INVALID_COUNTRY', 'country')],
  ['an empty warehouse', rejected('M-WAREHOUSE', { warehouse: '' }, 'MISSING_FIELD', 'warehouse')],
  ['a NUL inside the warehouse', rejected('M-WAREHOUSE-NUL', { warehouse: `W${NUL_CHARACTER}` }, 'INVALID_CHARACTER', 'warehouse')],
  ['an empty lot', rejected('M-LOT', { lot: '' }, 'MISSING_FIELD', 'lot')],
  ['an empty quantity', rejected('M-QTY-EMPTY', { quantity: '' }, 'MISSING_FIELD', 'quantity')],
  ['a negative quantity', rejected('M-QTY-NEG', { quantity: '-1' }, 'INVALID_QUANTITY', 'quantity')],
  ['a fractional quantity', rejected('M-QTY-FRAC', { quantity: '1.5' }, 'INVALID_QUANTITY', 'quantity')],
  ['a quantity one above the 32 bit maximum', rejected('M-QTY-MAX', { quantity: String(INT32_MAX + 1) }, 'INVALID_QUANTITY', 'quantity')],
  ['an empty unit cost', rejected('M-COST-EMPTY', { unit_cost: '' }, 'MISSING_FIELD', 'unit_cost')],
  ['a unit cost with sub-cent precision', rejected('M-COST-SUBCENT', { unit_cost: '1.005' }, 'INVALID_MONEY', 'unit_cost')],
  ['a unit cost one cent above the 32 bit maximum', rejected('M-COST-MAX', { unit_cost: '21474836.48' }, 'INVALID_MONEY', 'unit_cost')],
  ['a negative unit price', rejected('M-PRICE-NEG', { unit_price: '-$1.00' }, 'INVALID_MONEY', 'unit_price')],
  ['a NUL inside the unit price', rejected('M-PRICE-NUL', { unit_price: `2${NUL_CHARACTER}` }, 'INVALID_CHARACTER', 'unit_price')],
  ['an expiration with a two digit year', rejected('M-DATE-YY', { expiration: '3/4/30' }, 'INVALID_DATE', 'expiration')],
  ['an expiration on February 29 of a common year', rejected('M-DATE-LEAP', { expiration: '2/29/2023' }, 'INVALID_DATE', 'expiration')],
  ['an expiration in ISO format', rejected('M-DATE-ISO', { expiration: '2030-03-04' }, 'INVALID_DATE', 'expiration')],
  ['a record with one column missing', rawRejected(csvRecord(cellsOf({ ...BASE_CELLS, sku: 'M-COLS-LESS' }).slice(0, 11)), 'COLUMN_COUNT')],
  ['a record with one column extra', rawRejected(csvRecord([...cellsOf({ ...BASE_CELLS, sku: 'M-COLS-MORE' }), 'extra']), 'COLUMN_COUNT')],
];

const BOUNDARIES: ReadonlyArray<[string, LabeledRow]> = [
  ['a zero unit cost written with the dollar sign', accepted('B-COST-ZERO', { unit_cost: '$0.00' }, { unitCostCents: 0 })],
  ['a unit price with the dollar sign', accepted('B-PRICE-SYMBOL', { unit_price: '$2.50' }, {})],
  ['a zero quantity', accepted('B-QTY-ZERO', { quantity: '0' }, { quantity: 0 })],
  ['a unit price below the unit cost', accepted('B-MARGIN', { unit_cost: '9.99', unit_price: '0.01' }, { unitCostCents: 999, unitPriceCents: 1 })],
  ['an empty brand', accepted('B-BRAND', { brand: '' }, { brand: null })],
  ['an empty expiration', accepted('B-DATE-EMPTY', { expiration: '' }, { expiration: null })],
  ['a quantity at the 32 bit maximum', accepted('B-QTY-MAX', { quantity: String(INT32_MAX) }, { quantity: INT32_MAX })],
  ['a unit cost at the 32 bit maximum in cents', accepted('B-COST-MAX', { unit_cost: '$21474836.47' }, { unitCostCents: INT32_MAX })],
  ['a sku at the length limit', accepted('K'.repeat(SKU_MAX_LENGTH), {}, {})],
];

const MALFORMED_RECORD = csvRecord(cellsOf({ ...BASE_CELLS, sku: 'M-QUOTE' })).replace('Base widget', '"Base widget');

const MALFORMED_TAIL = rawRejected(MALFORMED_RECORD, 'MALFORMED_ROW');

interface QuoteBreak {
  record: string;
  broken: LabeledRow;
  next: LabeledRow;
  nextSku: string;
}

function quoteBreak(sku: string, name: string): QuoteBreak {
  const record = csvRecord(cellsOf({ ...BASE_CELLS, sku })).replace('Base widget', name);
  const nextSku = `${sku}-NEXT`;
  return { record, broken: rawRejected(record, 'MALFORMED_ROW'), next: accepted(nextSku, {}, {}), nextSku };
}

const QUOTE_BREAKS: ReadonlyArray<[string, QuoteBreak]> = [
  ['a stray quote inside an unquoted field', quoteBreak('M-QUOTE-STRAY', 'Base 12" widget')],
  ['text after the closing quote of a quoted field', quoteBreak('M-QUOTE-TAIL', '"Base widget"tail')],
];

const CORPUS = buildLabeledCsv(
  lines([
    ...BOUNDARIES.map(([, row]) => row),
    ...QUOTE_BREAKS.flatMap(([, quote]) => [quote.broken, quote.next]),
    ...MUTATIONS.map(([, row]) => row),
    MALFORMED_TAIL,
  ]),
);

const NAUGHTY = loadNaughtyStrings();

const EDGE_ROWS: readonly LabeledRow[] = [
  accepted('E-QUOTED', { name: 'Semi; colon "quoted" value' }, { name: 'Semi; colon "quoted" value' }),
  accepted('E-EMOJI', { name: 'Family 👨‍👩‍👧‍👦 flag 🏳️‍🌈' }, { name: 'Family 👨‍👩‍👧‍👦 flag 🏳️‍🌈' }),
  accepted('E-RTL', { name: 'עברית العربية ‮mirrored‬' }, { name: 'עברית العربية ‮mirrored‬' }),
  accepted('E-OGHAM', { name: 'Ogham space' }, { name: 'Ogham space' }),
  accepted('E-LF', { name: 'line one\nline two' }, { name: 'line one\nline two' }),
  accepted('E-CRLF', { name: 'line one\r\nline two' }, { name: 'line one\r\nline two' }),
  accepted('E-CR', { name: 'carriage\rreturn' }, { name: 'carriage\rreturn' }),
  accepted('E-LEAP', { expiration: '2/29/2024' }, { expiration: '2024-02-29' }),
  accepted('E-YEAR-END', { expiration: '12/31/2024' }, { expiration: '2024-12-31' }),
  accepted('E-PADDED-DATE', { expiration: '01/09/2031' }, { expiration: '2031-01-09' }),
  accepted('E-OLD-DATE', { expiration: '1/1/1900' }, { expiration: '1900-01-01' }),
  accepted('E-FAR-DATE', { expiration: '12/31/9999' }, { expiration: '9999-12-31' }),
  accepted('E-CENTS-1999', { unit_cost: '19.99', unit_price: '0.29' }, { unitCostCents: 1999, unitPriceCents: 29 }),
  accepted('E-CENTS-435', { unit_cost: '4.35', unit_price: '1.1' }, { unitCostCents: 435, unitPriceCents: 110 }),
  accepted('E-CENTS-INT', { unit_cost: '7', unit_price: '$0.07' }, { unitCostCents: 700, unitPriceCents: 7 }),
  { expected: 'blank' },
  ...NAUGHTY.map((name, index) => accepted(`E-NAUGHTY-${index}`, { name }, { name: name.trim() })),
];

const EDGES = buildLabeledCsv(lines(EDGE_ROWS, EOLS), { bom: true, headerEol: '\r\n' });

const textArb = fc
  .string({ unit: 'grapheme', minLength: 1, maxLength: 24 })
  .filter((value) => value.trim().length > 0 && !value.includes(NUL_CHARACTER));

interface GeneratedRow {
  cells: InventoryCells;
  item: ExpectedItem;
}

function moneyCell(cents: number, symbol: boolean): string {
  const units = Math.trunc(cents / 100);
  const rest = String(cents % 100).padStart(2, '0');
  return `${symbol ? '$' : ''}${units}.${rest}`;
}

const validRowArb: fc.Arbitrary<GeneratedRow> = fc
  .record({
    sku: fc.oneof(fc.constantFrom('P-A', 'P-B', 'p-a', 'ç-1', '🚀'), textArb.filter((value) => value.trim().length <= SKU_MAX_LENGTH)),
    name: textArb,
    category: textArb,
    brand: fc.option(textArb, { nil: null }),
    supplier: textArb,
    country: fc.constantFrom('US', 'BR', 'DE', 'JP', 'PT'),
    warehouse: fc.constantFrom('WH-1', 'wh-1', 'Armazém 2'),
    lot: fc.constantFrom('L1', 'L2'),
    quantity: fc.integer({ min: 0, max: INT32_MAX }),
    unitCostCents: fc.integer({ min: 0, max: INT32_MAX }),
    unitPriceCents: fc.integer({ min: 0, max: INT32_MAX }),
    costSymbol: fc.boolean(),
    priceSymbol: fc.boolean(),
    expiration: fc.option(fc.date({ min: new Date('1900-01-01T00:00:00Z'), max: new Date('9999-12-31T00:00:00Z'), noInvalidDate: true }), { nil: null }),
    padDate: fc.boolean(),
  })
  .map((value): GeneratedRow => {
    const date = value.expiration;
    const pad = (part: number): string => (value.padDate ? String(part).padStart(2, '0') : String(part));
    return {
      cells: {
        sku: value.sku,
        name: value.name,
        category: value.category,
        brand: value.brand ?? '',
        supplier: value.supplier,
        country: value.country,
        warehouse: value.warehouse,
        lot: value.lot,
        quantity: String(value.quantity),
        unit_cost: moneyCell(value.unitCostCents, value.costSymbol),
        unit_price: moneyCell(value.unitPriceCents, value.priceSymbol),
        expiration: date === null ? '' : `${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}/${date.getUTCFullYear()}`,
      },
      item: {
        sku: value.sku.trim(),
        name: value.name.trim(),
        category: value.category.trim(),
        brand: value.brand === null ? null : value.brand.trim(),
        supplier: value.supplier.trim(),
        country: value.country,
        warehouse: value.warehouse,
        lot: value.lot,
        quantity: value.quantity,
        unitCostCents: value.unitCostCents,
        unitPriceCents: value.unitPriceCents,
        expiration: date === null ? null : date.toISOString().slice(0, 10),
      },
    };
  });

interface Mutation {
  cells: Partial<InventoryCells>;
  code: InventoryRejectionCode;
  field: InventoryCsvColumn;
}

const mutationArb: fc.Arbitrary<Mutation> = fc.oneof(
  fc.record({ column: fc.constantFrom(...REQUIRED_COLUMNS), blank: fc.constantFrom('', ' ', '\t') }).map(
    ({ column, blank }): Mutation => ({ cells: { [column]: blank }, code: 'MISSING_FIELD', field: column }),
  ),
  fc.constantFrom(...ALL_COLUMNS).map((column): Mutation => ({ cells: { [column]: `x${NUL_CHARACTER}` }, code: 'INVALID_CHARACTER', field: column })),
  fc.integer({ min: SKU_MAX_LENGTH + 1, max: SKU_MAX_LENGTH * 2 }).map((length): Mutation => ({ cells: { sku: 'K'.repeat(length) }, code: 'INVALID_LENGTH', field: 'sku' })),
  fc.constantFrom('us', 'br', 'USA', 'U S').map((country): Mutation => ({ cells: { country }, code: 'INVALID_COUNTRY', field: 'country' })),
  fc.constantFrom('-1', '1.5', 'ten', '1e3', String(INT32_MAX + 1)).map((quantity): Mutation => ({ cells: { quantity }, code: 'INVALID_QUANTITY', field: 'quantity' })),
  fc
    .record({ column: fc.constantFrom<InventoryCsvColumn>('unit_cost', 'unit_price'), value: fc.constantFrom('-1.00', '1.005', '1,000.00', 'free', '21474836.48') })
    .map(({ column, value }): Mutation => ({ cells: { [column]: value }, code: 'INVALID_MONEY', field: column })),
  fc.constantFrom('13/1/2030', '2/30/2031', '3/4/30', '2030-03-04').map((expiration): Mutation => ({ cells: { expiration }, code: 'INVALID_DATE', field: 'expiration' })),
);

const labeledRowArb: fc.Arbitrary<LabeledRow> = fc.oneof(
  { weight: 3, arbitrary: validRowArb.map((row): LabeledRow => ({ expected: 'accepted', record: csvRecord(cellsOf(row.cells)), item: row.item })) },
  {
    weight: 1,
    arbitrary: fc.tuple(validRowArb, mutationArb).map(
      ([row, mutation]): LabeledRow => ({ expected: mutation.code, record: csvRecord(cellsOf({ ...row.cells, ...mutation.cells })), field: mutation.field }),
    ),
  },
  {
    weight: 1,
    arbitrary: fc.tuple(validRowArb, fc.boolean()).map(([row, extra]): LabeledRow => {
      const cells = cellsOf(row.cells);
      return { expected: 'COLUMN_COUNT', record: csvRecord(extra ? [...cells, 'extra'] : cells.slice(0, -1)), field: null };
    }),
  },
);

const labeledFileArb: fc.Arbitrary<LabeledLine[]> = fc.array(
  fc.record({ row: labeledRowArb, eol: fc.constantFrom<Eol>(...EOLS) }),
  { minLength: 1, maxLength: 40 },
);

describe('import verification by row', () => {
  let harness: ImportsHarness;
  let admin: SeededUser;

  async function run(csv: LabeledCsv, name: string): Promise<ImportOutcome> {
    const importId = await harness.importFile(admin.token, { content: csv.content, name });
    return outcomeOf(harness.prisma, importId);
  }

  beforeAll(async () => {
    harness = await ImportsHarness.start({ redisDb: 13, env: { IMPORT_BATCH_SIZE: '16', IMPORT_JOB_BACKOFF_MS: '20' } });
    await harness.reset();
    admin = await harness.loginAdmin();
  });

  afterAll(async () => {
    await harness.close();
  });

  describe('mutation corpus', () => {
    let outcome: ImportOutcome;

    beforeAll(async () => {
      await harness.prisma.import.deleteMany();
      outcome = await run(CORPUS, 'corpus.csv');
    });

    it.each(MUTATIONS)('rejects %s with its own code and field and keeps the raw record', (_label, row) => {
      const line = CORPUS.lineOf.get(row);
      const expected = CORPUS.rejections.find((rejection) => rejection.line === line);

      expect(expected).toBeDefined();
      expect(outcome.errors.filter((error) => error.line === line)).toEqual([expected]);
    });

    it.each(QUOTE_BREAKS)('rejects %s as a malformed row and accepts the next line', (_label, quote) => {
      const line = CORPUS.lineOf.get(quote.broken);

      expect(outcome.errors.filter((error) => error.line === line)).toEqual([{ line, field: null, code: 'MALFORMED_ROW', raw: quote.record }]);
      expect(CORPUS.lineOf.get(quote.next)).toBe((line ?? 0) + 1);
      expect(outcome.catalog.filter((stored) => stored.sku === quote.nextSku)).toHaveLength(1);
    });

    it('rejects a quote left open until the end of the file as a malformed row', () => {
      const line = CORPUS.lineOf.get(MALFORMED_TAIL);

      expect(outcome.errors.find((error) => error.line === line)).toMatchObject({ field: null, code: 'MALFORMED_ROW', raw: MALFORMED_RECORD });
    });

    it.each(BOUNDARIES)('accepts %s and stores it unchanged', (_label, row) => {
      const item = row.expected === 'accepted' ? row.item : undefined;

      expect(item).toBeDefined();
      expect(outcome.catalog.filter((stored) => stored.sku === item?.sku)).toEqual([item]);
    });

    it('covers every rejection code and accounts for every record exactly once', () => {
      expect(new Set(outcome.errors.map((error) => error.code))).toEqual(
        new Set<InventoryRejectionCode>(['COLUMN_COUNT', 'MALFORMED_ROW', 'MISSING_FIELD', 'INVALID_MONEY', 'INVALID_QUANTITY', 'INVALID_COUNTRY', 'INVALID_DATE', 'INVALID_CHARACTER', 'INVALID_LENGTH']),
      );
      expect(outcome).toEqual(expectedOutcome(CORPUS));
      expect(outcome.counters.acceptedRows + outcome.counters.rejectedRows).toBe(outcome.counters.totalRows);
    });
  });

  describe('valid edges and round trip', () => {
    let outcome: ImportOutcome;

    beforeAll(async () => {
      await harness.prisma.import.deleteMany();
      outcome = await run(EDGES, 'edges.csv');
    });

    it('accepts quoted delimiters, naughty strings, emoji, bidi text, line breaks inside quotes, leap days, a BOM and mixed line endings', () => {
      expect(NAUGHTY.length).toBeGreaterThan(0);
      expect(outcome).toEqual(expectedOutcome(EDGES));
    });

    it('stores every accepted text byte for byte, amounts in exact cents and the expiration as the written calendar date', () => {
      const stored = new Map(outcome.catalog.map((item) => [item.sku, item]));

      for (const item of EDGES.catalog) {
        const actual = stored.get(item.sku);
        expect(actual).toBeDefined();
        for (const key of ['sku', 'name', 'category', 'supplier', 'country', 'warehouse', 'lot'] as const) {
          expect(Buffer.compare(Buffer.from(actual?.[key] ?? ''), Buffer.from(item[key]))).toBe(0);
        }
        expect([actual?.quantity, actual?.unitCostCents, actual?.unitPriceCents, actual?.expiration]).toEqual([
          item.quantity,
          item.unitCostCents,
          item.unitPriceCents,
          item.expiration,
        ]);
      }
    });
  });

  describe('labeled rows generated by property', () => {
    it(
      'puts every valid row in the catalog after the identity merge and every invalid row in the errors with its code, never both nor neither',
      async () => {
        await fc.assert(
          fc.asyncProperty(labeledFileArb, async (generated) => {
            await harness.prisma.import.deleteMany();
            const csv = buildLabeledCsv(generated);

            const outcome = await run(csv, 'generated.csv');

            expect(outcome).toEqual(expectedOutcome(csv));
            expect(outcome.counters.acceptedRows + outcome.counters.rejectedRows).toBe(generated.length);
            const rejectedLines = new Set(outcome.errors.map((error) => error.line));
            const acceptedLines = generated.filter(({ row }) => row.expected === 'accepted').map(({ row }) => csv.lineOf.get(row));
            expect(acceptedLines.filter((line) => line !== undefined && rejectedLines.has(line))).toEqual([]);
            expect(rejectedLines.size + acceptedLines.length).toBe(generated.length);
          }),
          { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
        );
      },
      PROPERTY_TIMEOUT_MS,
    );
  });
});
