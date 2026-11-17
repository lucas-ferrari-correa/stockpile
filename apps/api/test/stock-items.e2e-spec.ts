import { randomUUID } from 'node:crypto';
import {
  BASE_CURRENCY,
  INVENTORY_CSV_HEADER,
  ImportStatus,
  STOCK_ITEM_SORTS,
  SortOrder,
  StockItem,
  StockItemPage,
  StockItemSort,
  stockItemPageSchema,
} from '@stockpile/shared';
import request from 'supertest';
import { AppConfigService } from '../src/infra/config/app-config.service';
import { ExchangeRatesProvider, LatestRates } from '../src/modules/exchange-rates/ports/exchange-rates.provider';
import { csvRecord } from './import-verification/labeled-csv';
import { ImportsHarness, SeededUser, waitFor } from './support/imports-harness';

interface SeedRow {
  sku: string;
  name: string;
  category: string;
  brand: string | null;
  supplier: string;
  country: string;
  warehouse: string;
  lot: string;
  quantity: number;
  unitCostCents: number;
  unitPriceCents: number;
  expiration: string | null;
}

interface CatalogItem extends SeedRow {
  id: number;
  importId: string;
}

interface RateTable {
  date: string;
  source: string;
  decimals: readonly string[];
}

type QueryValue = string | number | readonly string[];

type QueryParams = Readonly<Record<string, QueryValue | undefined>>;

class SwitchableRatesProvider implements ExchangeRatesProvider {
  current: LatestRates = { date: '2026-01-01', rates: {}, source: 'unset.example.test' };

  fetchLatest(): Promise<LatestRates> {
    return Promise.resolve(this.current);
  }
}

const RATES_A: RateTable = {
  date: '2026-03-04',
  source: 'first.example.test',
  decimals: ['1.5', '0.125', '150.25', '7.0005', '0.5', '5.4321', '4000.5'],
};

const RATES_B: RateTable = {
  date: '2026-06-30',
  source: 'second.example.test',
  decimals: ['2.5', '0.375', '98.765', '0.0015', '1.3333', '0.5', '3999.99'],
};

const CATEGORIES = ['Bakery', 'Dairy', 'Frozen', 'Produce'] as const;
const BRANDS = ['Acme', 'Bolt', 'Crest'] as const;
const SUPPLIERS = ['Northwind', 'Southwind'] as const;
const COUNTRIES = ['US', 'BR', 'DE'] as const;
const WAREHOUSES = ['WHA', 'WHB', 'WHC'] as const;
const EXPIRATIONS = ['2026-12-31', '2027-03-14', '2027-03-31', '2028-02-29', '2028-03-14'] as const;
const SORTED_ROWS = 30;

function pick<T>(values: readonly T[], index: number): T {
  const value = values[index % values.length];
  if (value === undefined) {
    throw new Error('Empty value list');
  }
  return value;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function sortedRows(): SeedRow[] {
  return Array.from({ length: SORTED_ROWS }, (_, index): SeedRow => ({
    sku: `SKU${pad2(index % 10)}`,
    name: `Item${pad2(index % 7)}`,
    category: pick(CATEGORIES, index),
    brand: index % 5 === 0 ? null : pick(BRANDS, index),
    supplier: pick(SUPPLIERS, index),
    country: pick(COUNTRIES, index),
    warehouse: pick(WAREHOUSES, index),
    lot: `L${pad2(index)}`,
    quantity: ((index * 7) % 5) * 10,
    unitCostCents: (index % 6) * 250 + (index % 4 === 1 ? 1 : 0),
    unitPriceCents: ((index * 3) % 8) * 200,
    expiration: index % 4 === 3 ? null : pick(EXPIRATIONS, index),
  }));
}

const SEARCH_BASE: SeedRow = {
  sku: 'SRCH',
  name: 'Searchable',
  category: 'Pantry',
  brand: 'Zenith',
  supplier: 'Quirky Supply',
  country: 'CA',
  warehouse: 'WHZ',
  lot: 'S',
  quantity: 3,
  unitCostCents: 77,
  unitPriceCents: 99,
  expiration: '2026-10-05',
};

function searchRows(): SeedRow[] {
  const row = (lot: string, fields: Partial<SeedRow>): SeedRow => ({ ...SEARCH_BASE, lot, ...fields });
  return [
    row('S-PERCENT', { name: '50% Off Cheese', expiration: '2026-10-27' }),
    row('S-FIVE-HUNDRED', { name: 'Promo 500 Crackers', expiration: '2027-10-27' }),
    row('S-UNDERSCORE', { sku: 'UNDER_SCORE', name: 'Snake case', brand: null }),
    row('LOT-2/30', { name: 'Odd lot', expiration: null }),
    row('S-PRICE', { name: 'Priced', unitPriceCents: 1250, unitCostCents: 800 }),
    row('S-COST', { name: 'Costed', unitPriceCents: 1999, unitCostCents: 1250, supplier: 'Northwind' }),
    row('S-MIXED', { sku: 'mixed-Case-SKU', name: 'Mixed', brand: 'Bolt', expiration: '2028-02-29' }),
    { ...pick(sortedRows(), 0), name: 'Moved Item', unitPriceCents: 4321, quantity: 99 },
  ];
}

function money(cents: number): string {
  return `${Math.floor(cents / 100)}.${pad2(cents % 100)}`;
}

function usDate(iso: string | null): string {
  if (iso === null) {
    return '';
  }
  const [year = '', month = '', day = ''] = iso.split('-');
  return `${Number(month)}/${Number(day)}/${year}`;
}

function csvOf(rows: readonly SeedRow[]): string {
  const records = rows.map((row) =>
    csvRecord([
      row.sku,
      row.name,
      row.category,
      row.brand ?? '',
      row.supplier,
      row.country,
      row.warehouse,
      row.lot,
      String(row.quantity),
      money(row.unitCostCents),
      money(row.unitPriceCents),
      usDate(row.expiration),
    ]),
  );
  return `${INVENTORY_CSV_HEADER}\n${records.join('\n')}\n`;
}

function identity(row: Pick<SeedRow, 'sku' | 'warehouse' | 'lot'>): string {
  return JSON.stringify([row.sku, row.warehouse, row.lot]);
}

function halfUpCents(cents: number, rate: string): number {
  const [whole = '', fraction = ''] = rate.split('.');
  const scale = 10n ** BigInt(fraction.length);
  const product = BigInt(cents) * BigInt(`${whole}${fraction}`);
  const quotient = product / scale;
  return Number((product % scale) * 2n >= scale ? quotient + 1n : quotient);
}

type SortKey = string | number | null;

function sortKey(item: CatalogItem, sort: StockItemSort): SortKey {
  switch (sort) {
    case 'sku':
      return item.sku;
    case 'name':
      return item.name;
    case 'category':
      return item.category;
    case 'warehouse':
      return item.warehouse;
    case 'quantity':
      return item.quantity;
    case 'unitCost':
      return item.unitCostCents;
    case 'unitPrice':
      return item.unitPriceCents;
    case 'margin':
      return item.unitPriceCents - item.unitCostCents;
    case 'expiration':
      return item.expiration;
  }
}

function referenceOrder(items: readonly CatalogItem[], sort: StockItemSort, order: SortOrder): number[] {
  const direction = order === 'asc' ? 1 : -1;
  const compare = (left: SortKey, right: SortKey): number => {
    if (left === right) {
      return 0;
    }
    if (left === null) {
      return 1;
    }
    if (right === null) {
      return -1;
    }
    return left < right ? -direction : direction;
  };
  return [...items]
    .sort((left, right) => compare(sortKey(left, sort), sortKey(right, sort)) || (left.id - right.id) * direction)
    .map((item) => item.id);
}

function queryString(params: QueryParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) {
      continue;
    }
    for (const entry of typeof value === 'string' || typeof value === 'number' ? [value] : value) {
      search.append(key, String(entry));
    }
  }
  return search.toString();
}

function forgedCursor(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function sortedIds(items: ReadonlyArray<{ id: number }>): number[] {
  return items.map((item) => item.id).sort((left, right) => left - right);
}

describe('stock items', () => {
  let harness: ImportsHarness;
  let admin: SeededUser;
  let token: string;
  let currencies: string[];
  const rates = new SwitchableRatesProvider();
  const ratesByImport = new Map<string, RateTable>();
  let importA: string;
  let importB: string;
  let catalog: CatalogItem[];

  const http = (params: QueryParams): request.Test =>
    request(harness.app.getHttpServer()).get(`/stock-items?${queryString(params)}`).auth(token, { type: 'bearer' });

  const page = async (params: QueryParams): Promise<StockItemPage> => stockItemPageSchema.parse((await http(params).expect(200)).body);

  const walk = async (params: QueryParams): Promise<StockItemPage[]> => {
    const pages: StockItemPage[] = [];
    let cursor: string | undefined;
    do {
      const current = await page({ ...params, cursor });
      pages.push(current);
      cursor = current.nextCursor ?? undefined;
      if (pages.length > 200) {
        throw new Error('Pagination did not terminate');
      }
    } while (cursor !== undefined);
    return pages;
  };

  const itemsOf = (pages: readonly StockItemPage[]): StockItem[] => pages.flatMap((current) => current.items);

  const ratesFor = (table: RateTable): LatestRates => ({
    date: table.date,
    source: table.source,
    rates: Object.fromEntries(currencies.map((currency, index) => [currency, Number(pick(table.decimals, index))])),
  });

  const importWith = async (table: RateTable, rows: readonly SeedRow[], name: string): Promise<string> => {
    rates.current = ratesFor(table);
    const importId = await harness.importFile(token, { content: csvOf(rows), name });
    ratesByImport.set(importId, table);
    return importId;
  };

  beforeAll(async () => {
    harness = await ImportsHarness.start({ redisDb: 11, rates, env: { IMPORT_JOB_BACKOFF_MS: '20' } });
    const roles = await harness.reset();
    admin = await harness.login(roles.adminRoleId);
    token = admin.token;
    currencies = harness.app.get(AppConfigService).get('EXCHANGE_CURRENCIES');

    importA = await importWith(RATES_A, sortedRows(), 'sorted.csv');
    importB = await importWith(RATES_B, searchRows(), 'search.csv');

    const seeded = new Map<string, SeedRow>([...sortedRows(), ...searchRows()].map((row) => [identity(row), row]));
    const stored = await harness.prisma.stockItem.findMany({ select: { id: true, importId: true, sku: true, warehouse: true, lot: true } });
    catalog = stored.map((row): CatalogItem => {
      const seed = seeded.get(identity(row));
      if (seed === undefined) {
        throw new Error(`Unexpected stored item ${identity(row)}`);
      }
      return { ...seed, id: row.id, importId: row.importId };
    });
    expect(catalog).toHaveLength(seeded.size);
  }, 60000);

  afterAll(async () => {
    await harness.close();
  });

  describe('listing', () => {
    const onlyA = (): CatalogItem[] => catalog.filter((item) => item.importId === importA);

    it.each(STOCK_ITEM_SORTS.flatMap((sort) => (['asc', 'desc'] as const).map((order): [StockItemSort, SortOrder] => [sort, order])))(
      'pages by %s %s through every item once in the reference order, with total only on the first page',
      async (sort, order) => {
        const expected = referenceOrder(onlyA(), sort, order);

        const pages = await walk({ importId: importA, sort, order, limit: 4 });

        expect(itemsOf(pages).map((item) => item.id)).toEqual(expected);
        expect(pages.map((current) => current.total)).toEqual([expected.length, ...pages.slice(1).map(() => null)]);
        expect(pages.at(-1)?.nextCursor).toBeNull();
      },
    );

    it('lists the whole catalog without importId and only the items currently owned by the import with it', async () => {
      const global = await walk({ limit: 200 });
      const scopedA = await walk({ importId: importA, limit: 200 });
      const scopedB = await walk({ importId: importB, limit: 200 });

      expect(sortedIds(itemsOf(global))).toEqual(sortedIds(catalog));
      expect(global[0]?.total).toBe(catalog.length);
      expect(sortedIds(itemsOf(scopedA))).toEqual(sortedIds(onlyA()));
      expect(scopedA[0]?.total).toBe(SORTED_ROWS - 1);
      expect(sortedIds(itemsOf(scopedB))).toEqual(sortedIds(catalog.filter((item) => item.importId === importB)));
      expect(itemsOf(scopedB).find((item) => item.lot === 'L00')).toMatchObject({ name: 'Moved Item', unitPriceCents: 4321 });
    });

    it('returns every field of each item with conversions computed half-up from the snapshot of its own import', async () => {
      const items = itemsOf(await walk({ limit: 7 }));
      const byId = new Map(catalog.map((item) => [item.id, item]));

      expect(new Set(items.map((item) => item.importId))).toEqual(new Set([importA, importB]));
      for (const item of items) {
        const expected = byId.get(item.id);
        const table = expected === undefined ? undefined : ratesByImport.get(expected.importId);
        if (expected === undefined || table === undefined) {
          throw new Error(`Unknown item ${item.id}`);
        }
        expect(item).toEqual({
          ...expected,
          marginCents: expected.unitPriceCents - expected.unitCostCents,
          rates: { base: BASE_CURRENCY, date: table.date, source: table.source },
          conversions: currencies.map((currency, index) => {
            const rate = pick(table.decimals, index);
            return {
              currency,
              rate: Number(rate),
              unitCostCents: halfUpCents(expected.unitCostCents, rate),
              unitPriceCents: halfUpCents(expected.unitPriceCents, rate),
            };
          }),
        });
      }
    });

    describe('filters', () => {
      const cases: Array<[string, QueryParams, (item: CatalogItem) => boolean]> = [
        ['one category', { category: 'Dairy' }, (item) => item.category === 'Dairy'],
        ['several categories', { category: ['Dairy', 'Pantry'] }, (item) => ['Dairy', 'Pantry'].includes(item.category)],
        ['several brands, never matching a missing brand', { brand: ['Acme', 'Zenith'] }, (item) => item.brand === 'Acme' || item.brand === 'Zenith'],
        ['a supplier', { supplier: 'Southwind' }, (item) => item.supplier === 'Southwind'],
        ['several countries', { country: ['BR', 'CA'] }, (item) => ['BR', 'CA'].includes(item.country)],
        ['several warehouses', { warehouse: ['WHA', 'WHZ'] }, (item) => ['WHA', 'WHZ'].includes(item.warehouse)],
        ['a minimum price', { minPrice: '8.00' }, (item) => item.unitPriceCents >= 800],
        ['a maximum price with a dollar sign', { maxPrice: '$4' }, (item) => item.unitPriceCents <= 400],
        ['an exact price range', { minPrice: '12.50', maxPrice: '12.50' }, (item) => item.unitPriceCents === 1250],
        ['a minimum cost on a cent boundary', { minCost: '2.51' }, (item) => item.unitCostCents >= 251],
        ['a maximum cost', { maxCost: '2.50' }, (item) => item.unitCostCents <= 250],
        ['a minimum quantity', { minQuantity: 30 }, (item) => item.quantity >= 30],
        ['a zero maximum quantity', { maxQuantity: 0 }, (item) => item.quantity === 0],
        ['an expiration start', { expiresFrom: '2027-03-14' }, (item) => item.expiration !== null && item.expiration >= '2027-03-14'],
        ['an expiration end', { expiresTo: '2027-03-14' }, (item) => item.expiration !== null && item.expiration <= '2027-03-14'],
        [
          'an expiration window',
          { expiresFrom: '2027-03-14', expiresTo: '2027-03-31' },
          (item) => item.expiration !== null && item.expiration >= '2027-03-14' && item.expiration <= '2027-03-31',
        ],
        ['no expiration', { expiration: 'none' }, (item) => item.expiration === null],
        [
          'category, warehouse and minimum price together',
          { category: ['Dairy', 'Frozen'], warehouse: 'WHB', minPrice: '2' },
          (item) => ['Dairy', 'Frozen'].includes(item.category) && item.warehouse === 'WHB' && item.unitPriceCents >= 200,
        ],
        [
          'country, no expiration and maximum quantity together',
          { country: 'US', expiration: 'none', maxQuantity: 30 },
          (item) => item.country === 'US' && item.expiration === null && item.quantity <= 30,
        ],
      ];

      it.each(cases)('narrows to %s with a matching total', async (_, params, predicate) => {
        const expected = catalog.filter(predicate);

        const pages = await walk({ ...params, sort: 'unitPrice', limit: 5 });

        expect(expected.length).toBeGreaterThan(0);
        expect(expected.length).toBeLessThan(catalog.length);
        expect(sortedIds(itemsOf(pages))).toEqual(sortedIds(expected));
        expect(pages[0]?.total).toBe(expected.length);
      });
    });

    describe('search', () => {
      const lots = (predicate: (item: CatalogItem) => boolean): string[] => catalog.filter(predicate).map((item) => item.lot).sort();
      const searchLots = async (params: QueryParams): Promise<{ lots: string[]; total: number | null | undefined }> => {
        const pages = await walk({ ...params, sort: 'sku', limit: 3 });
        return { lots: itemsOf(pages).map((item) => item.lot).sort(), total: pages[0]?.total };
      };
      const containing = (term: string) => (item: CatalogItem): boolean =>
        [item.sku, item.name, item.brand, item.supplier, item.lot].some((value) => value?.toLowerCase().includes(term.toLowerCase()) ?? false);
      const expiringOn = (match: (date: string) => boolean) => (item: CatalogItem): boolean => item.expiration !== null && match(item.expiration);

      const cases: Array<[string, string, (item: CatalogItem) => boolean]> = [
        ['a name case-insensitively', 'CHEESE', (item) => item.lot === 'S-PERCENT'],
        ['a sku fragment', 'case-sku', (item) => item.lot === 'S-MIXED'],
        ['a brand', 'zenITH', (item) => item.brand === 'Zenith'],
        ['a supplier fragment', 'quirky', (item) => item.supplier === 'Quirky Supply'],
        ['a lot', 'l07', (item) => item.lot === 'L07'],
        ['a percent sign literally', '50%', (item) => item.lot === 'S-PERCENT'],
        ['an underscore literally', '_', (item) => item.lot === 'S-UNDERSCORE'],
        ['a backslash literally', '\\', () => false],
        ['an amount equal to the price', '12.50', (item) => item.unitPriceCents === 1250 || item.unitCostCents === 1250],
        ['an amount with a dollar sign', '$12.5', (item) => item.unitPriceCents === 1250 || item.unitCostCents === 1250],
        ['a whole amount or a text fragment', '6', (item) => containing('6')(item) || item.unitPriceCents === 600 || item.unitCostCents === 600],
        ['a full date', '3/14/2027', expiringOn((date) => date === '2027-03-14')],
        ['a month and day in any year', '3/14', expiringOn((date) => date.endsWith('-03-14'))],
        ['a leap day in any year', '2/29', expiringOn((date) => date.endsWith('-02-29'))],
        ['a month of a year', '3/2027', expiringOn((date) => date.startsWith('2027-03-'))],
        ['an impossible day as text', '2/30', (item) => item.lot === 'LOT-2/30'],
        ['an impossible full date as text', '2/30/2027', () => false],
      ];

      it.each(cases)('matches %s', async (_, q, predicate) => {
        const expected = lots(predicate);

        expect(await searchLots({ q })).toEqual({ lots: expected, total: expected.length });
      });

      it('combines search and filters within an import or across the catalog', async () => {
        const northwindA = lots((item) => item.importId === importA && item.supplier === 'Northwind');
        const inImport = lots((item) => item.importId === importB && item.expiration !== null && item.expiration.endsWith('-10-27'));
        const filtered = lots((item) => item.supplier === 'Northwind' && item.expiration !== null && item.expiration.startsWith('2027-03-'));

        expect(await searchLots({ importId: importA, supplier: 'Northwind' })).toEqual({ lots: northwindA, total: northwindA.length });
        expect(await searchLots({ q: '10/27', importId: importB })).toEqual({ lots: inImport, total: 2 });
        expect(await searchLots({ q: '10/27', importId: importA })).toEqual({ lots: [], total: 0 });
        expect(await searchLots({ q: '3/2027', supplier: 'Northwind' })).toEqual({ lots: filtered, total: filtered.length });
      });

      it('keeps expiration matches on the calendar day whatever the time zone', async () => {
        const utc = await searchLots({ q: '10/27/2026' });

        expect(utc.lots).toEqual(['S-PERCENT']);
        expect(await searchLots({ q: '10/27/2026', tz: 'Pacific/Kiritimati' })).toEqual(utc);
        expect(await searchLots({ q: '10/27/2026', tz: 'Pacific/Pago_Pago' })).toEqual(utc);
      });
    });

    it('selects imports by their creation day in the requested time zone', async () => {
      const original = await harness.prisma.import.findMany({ where: { id: { in: [importA, importB] } }, select: { id: true, createdAt: true } });
      await harness.prisma.import.update({ where: { id: importA }, data: { createdAt: new Date('2026-03-14T23:30:00.000Z') } });
      await harness.prisma.import.update({ where: { id: importB }, data: { createdAt: new Date('2026-03-15T02:00:00.000Z') } });
      const ownedBy = (importId: string): number[] => sortedIds(catalog.filter((item) => item.importId === importId));

      try {
        const utcFrom = await walk({ createdFrom: '2026-03-15', limit: 200 });
        const utcTo = await walk({ createdTo: '2026-03-14', limit: 200 });
        const newYork = await walk({ createdFrom: '2026-03-14', createdTo: '2026-03-14', tz: 'America/New_York', limit: 200 });
        const newYorkNextDay = await walk({ createdFrom: '2026-03-15', tz: 'America/New_York', limit: 200 });

        expect(sortedIds(itemsOf(utcFrom))).toEqual(ownedBy(importB));
        expect(sortedIds(itemsOf(utcTo))).toEqual(ownedBy(importA));
        expect(sortedIds(itemsOf(newYork))).toEqual(sortedIds(catalog));
        expect(newYork[0]?.total).toBe(catalog.length);
        expect(itemsOf(newYorkNextDay)).toEqual([]);
      } finally {
        for (const row of original) {
          await harness.prisma.import.update({ where: { id: row.id }, data: { createdAt: row.createdAt } });
        }
      }
    });

    describe('cursor', () => {
      const firstCursor = async (params: QueryParams): Promise<string> => {
        const cursor = (await page({ ...params, limit: 2 })).nextCursor;
        if (cursor === null) {
          throw new Error('Expected a next page');
        }
        return cursor;
      };

      it.each<[string, () => QueryParams | Promise<QueryParams>]>([
        ['another sort', async () => ({ sort: 'name', cursor: await firstCursor({ sort: 'sku' }) })],
        ['another order', async () => ({ sort: 'sku', order: 'desc', cursor: await firstCursor({ sort: 'sku', order: 'asc' }) })],
        [
          'an anchor outside the requested import',
          async () => ({ importId: importA, sort: 'sku', cursor: await firstCursor({ importId: importB, sort: 'sku' }) }),
        ],
        ['an anchor that does not exist', () => ({ sort: 'sku', cursor: forgedCursor({ sort: 'sku', order: 'asc', id: 2_000_000_000 }) })],
        ['a non positive id', () => ({ sort: 'sku', cursor: forgedCursor({ sort: 'sku', order: 'asc', id: 0 }) })],
        ['a textual id', () => ({ sort: 'sku', cursor: forgedCursor({ sort: 'sku', order: 'asc', id: '1' }) })],
        ['a missing order', () => ({ sort: 'sku', cursor: forgedCursor({ sort: 'sku', id: 1 }) })],
        ['a payload that is not JSON', () => ({ sort: 'sku', cursor: Buffer.from('{sort:sku', 'utf8').toString('base64url') })],
        [
          'a tampered payload',
          async () => {
            const cursor = await firstCursor({ sort: 'sku' });
            return { sort: 'sku', cursor: `${cursor.slice(0, 4)}${cursor.charAt(4) === 'A' ? 'B' : 'A'}${cursor.slice(5)}` };
          },
        ],
      ])('rejects a cursor with %s as INVALID_CURSOR', async (_, build) => {
        const response = await http(await build()).expect(400);

        expect(response.body).toMatchObject({ statusCode: 400, code: 'INVALID_CURSOR' });
      });

      it('rejects a cursor that is not base64url', async () => {
        await http({ sort: 'sku', cursor: 'not a cursor!' }).expect(400);
      });
    });
  });

  describe('http', () => {
    const NOT_COMPLETED: readonly ImportStatus[] = ['pending', 'processing', 'failed'];

    const anonymous = (params: QueryParams, headers: Readonly<Record<string, string>> = {}): request.Test =>
      request(harness.app.getHttpServer()).get(`/stock-items?${queryString(params)}`).set(headers);

    const get = (params: QueryParams, headers: Readonly<Record<string, string>> = {}, bearer: string = token): request.Test =>
      anonymous(params, headers).auth(bearer, { type: 'bearer' });

    const etagOf = async (params: QueryParams, bearer: string = token): Promise<string> => {
      const etag = (await get(params, {}, bearer).expect(200)).get('ETag');
      if (etag === undefined) {
        throw new Error('Expected an ETag');
      }
      return etag;
    };

    const ifNoneMatch = (params: QueryParams, header: string, bearer: string = token): request.Test => get(params, { 'If-None-Match': header }, bearer);

    const varyOf = (response: request.Response): string[] => (response.get('Vary') ?? '').split(',').map((value) => value.trim().toLowerCase());

    const roleWithoutPermissions = async (): Promise<string> =>
      (await harness.prisma.role.create({ data: { name: `no-permissions-${randomUUID()}` }, select: { id: true } })).id;

    const etagRow = (sku: string, name: string): SeedRow => ({ ...SEARCH_BASE, sku, name, warehouse: 'WHE', lot: 'E' });

    it.each<[string, () => QueryParams]>([
      ['the catalog', () => ({ sort: 'name' })],
      ['an import', () => ({ importId: importA, sort: 'name' })],
    ])('answers a listing of %s with a strong ETag, private no-cache caching and a Vary on the credentials', async (_, params) => {
      const response = await get(params()).expect(200);

      expect(stockItemPageSchema.parse(response.body).items.length).toBeGreaterThan(0);
      expect(response.get('ETag')).toMatch(/^"[\w-]+"$/);
      expect(response.get('Cache-Control')).toBe('private, no-cache');
      expect(varyOf(response)).toEqual(expect.arrayContaining(['authorization', 'x-api-key']));
    });

    it.each<[string, (etag: string) => string]>([
      ['the current ETag', (etag) => etag],
      ['a list holding the current ETag in the middle', (etag) => `"stale-one", ${etag}, "stale-two"`],
      ['a wildcard', () => '*'],
      ['the weak form of the current ETag', (etag) => `W/${etag}`],
    ])('answers 304 without a body to If-None-Match with %s', async (_, header) => {
      for (const params of [{ sort: 'name' }, { importId: importA, sort: 'name' }]) {
        const etag = await etagOf(params);

        const response = await ifNoneMatch(params, header(etag)).expect(304);

        expect(response.text).toBe('');
        expect(response.get('ETag')).toBe(etag);
        expect(response.get('Cache-Control')).toBe('private, no-cache');
        expect(varyOf(response)).toEqual(expect.arrayContaining(['authorization', 'x-api-key']));
      }
    });

    it('answers 200 with the page when If-None-Match holds only other tags', async () => {
      const otherQuery = await etagOf({ sort: 'sku' });

      const response = await ifNoneMatch({ sort: 'name' }, `"stale", W/"older", ${otherQuery}`).expect(200);

      expect(stockItemPageSchema.parse(response.body).items.length).toBeGreaterThan(0);
      expect(response.get('ETag')).not.toBe(otherQuery);
    });

    it('gives each query its own ETag and the same ETag to equivalent queries', async () => {
      const cursor = (await page({ sort: 'name', limit: 2 })).nextCursor ?? undefined;
      const variants: QueryParams[] = [
        { sort: 'name' },
        { sort: 'name', order: 'desc' },
        { sort: 'name', limit: 5 },
        { sort: 'name', limit: 2, cursor },
        { sort: 'name', category: 'Dairy' },
        { sort: 'name', q: 'cheese' },
        { sort: 'name', tz: 'America/New_York' },
        { sort: 'name', importId: importA },
        { sort: 'name', importId: importB },
      ];

      const etags = await Promise.all(variants.map((params) => etagOf(params)));
      const reordered = await request(harness.app.getHttpServer())
        .get('/stock-items?category=Dairy&limit=5&sort=name')
        .auth(token, { type: 'bearer' })
        .expect(200);

      expect(cursor).toBeDefined();
      expect(new Set(etags).size).toBe(variants.length);
      expect(reordered.get('ETag')).toBe(await etagOf({ sort: 'name', limit: 5, category: 'Dairy' }));
      expect(await etagOf({})).toBe(await etagOf({ sort: 'sku', order: 'asc', limit: 50, tz: 'UTC' }));
    });

    it('changes the catalog ETag when an import completes and the ETag of an import only when a later import takes its items', async () => {
      const catalogBefore = await etagOf({});
      const untouchedBefore = await etagOf({ importId: importA });
      const created: string[] = [];

      try {
        const donor = await importWith(RATES_A, [etagRow('ETAG-1', 'Donor one'), etagRow('ETAG-2', 'Donor two')], 'etag-donor.csv');
        created.push(donor);
        const catalogAfterDonor = await etagOf({});
        const donorBefore = await etagOf({ importId: donor });

        expect(catalogAfterDonor).not.toBe(catalogBefore);
        await ifNoneMatch({}, catalogBefore).expect(200);
        expect(await etagOf({ importId: importA })).toBe(untouchedBefore);

        const taker = await importWith(RATES_B, [etagRow('ETAG-1', 'Taken')], 'etag-taker.csv');
        created.push(taker);

        expect(await etagOf({ importId: donor })).not.toBe(donorBefore);
        await ifNoneMatch({ importId: donor }, donorBefore).expect(200);
        expect(await etagOf({})).not.toBe(catalogAfterDonor);
        await ifNoneMatch({ importId: importA }, untouchedBefore).expect(304);
      } finally {
        for (const importId of created) {
          await waitFor(() => harness.queue.getJobState(importId), (state) => state === 'completed' || state === 'failed');
          ratesByImport.delete(importId);
        }
        await harness.prisma.import.deleteMany({ where: { id: { in: created } } });
      }
    }, 60000);

    it('serves the catalog and an import to an active user whose role holds no permission', async () => {
      const user = await harness.login(await roleWithoutPermissions());

      for (const params of [{ sort: 'name' }, { importId: importB, sort: 'name' }]) {
        const own = await get(params, {}, user.token).expect(200);
        const administrator = await get(params).expect(200);

        expect(own.body).toEqual(administrator.body);
        expect(own.get('ETag')).toBe(administrator.get('ETag'));
      }
    });

    it('answers 403 instead of 304 to a blocked user holding a valid ETag and 401 without credentials', async () => {
      const user = await harness.login(await roleWithoutPermissions());
      const etag = await etagOf({}, user.token);
      await harness.prisma.user.update({ where: { id: user.id }, data: { status: 'BLOCKED' }, select: { id: true } });

      const blocked = await ifNoneMatch({}, etag, user.token).expect(403);
      const unauthenticated = await anonymous({}, { 'If-None-Match': etag }).expect(401);

      expect(blocked.body).toMatchObject({ statusCode: 403, code: 'ACCOUNT_BLOCKED' });
      expect(blocked.get('ETag')).toBeUndefined();
      expect(unauthenticated.body).toMatchObject({ statusCode: 401, code: 'UNAUTHENTICATED' });
      expect(unauthenticated.get('ETag')).toBeUndefined();
    });

    it.each(NOT_COMPLETED)('answers 409 IMPORT_NOT_COMPLETED without an ETag for a %s import, even to a wildcard If-None-Match', async (status) => {
      const { id } = await harness.prisma.import.create({
        data: { fileName: `${status}.csv`, status, createdById: admin.id },
        select: { id: true },
      });

      try {
        const response = await ifNoneMatch({ importId: id }, '*').expect(409);

        expect(response.body).toEqual({ statusCode: 409, code: 'IMPORT_NOT_COMPLETED', message: 'The import has not completed yet' });
        expect(response.get('ETag')).toBeUndefined();
      } finally {
        await harness.prisma.import.delete({ where: { id }, select: { id: true } });
      }
    });

    it('answers 404 IMPORT_NOT_FOUND for an unknown importId and 400 for a malformed one', async () => {
      const unknown = await ifNoneMatch({ importId: randomUUID() }, '*').expect(404);
      const malformed = await get({ importId: 'not-a-uuid' }).expect(400);

      expect(unknown.body).toEqual({ statusCode: 404, code: 'IMPORT_NOT_FOUND', message: 'Import not found' });
      expect(unknown.get('ETag')).toBeUndefined();
      expect(malformed.get('ETag')).toBeUndefined();
    });
  });
});
