import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  StockItem,
  StockItemConversion,
  StockItemPage,
  StockItemRates,
  StockItemSort,
  StockItemsQuery,
} from '@stockpile/shared';
import { z } from 'zod';
import { AppConfigService } from '../../../infra/config/app-config.service';
import { fromDbDate } from '../../../infra/dates/calendar-date';
import { ListingCursor, ListingDefinition, ListingModel, ListingService, listingColumns } from '../../../infra/listing/listing';
import {
  SQL_TRUE,
  sqlAnd,
  sqlCalendarDay,
  sqlCalendarMatch,
  sqlCompare,
  sqlContains,
  sqlDate,
  sqlIn,
  sqlInstantRange,
  sqlOr,
  sqlOrder,
} from '../../../infra/listing/listing-sql';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { convertCents } from '../../exchange-rates/domain/exchange-rates';
import { importNotFound } from '../../imports/application/imports.errors';
import { importNotCompleted, invalidCursor } from './stock-items.errors';

export type StockItemsScope =
  | { kind: 'import'; importId: string; updatedAt: Date; itemCount: number }
  | { kind: 'catalog'; completedImports: number; lastChangeAt: Date | null; itemCount: number };

export interface StockItemsListing {
  query: StockItemsQuery;
  scope: StockItemsScope;
  cursor: ListingCursor | null;
}

const stockItemRowSchema = z.object({
  id: z.number().int(),
  importId: z.string(),
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
  expiration: z.date().nullable(),
});

type StockItemRow = z.infer<typeof stockItemRowSchema>;

const dateBoundsSchema = z.object({ min: z.date().nullable(), max: z.date().nullable() });

const countSchema = z.object({ total: z.number().int().nonnegative() });

const snapshotRatesSchema = z.record(z.string(), z.number().positive());

interface StockItemsListingModel extends ListingModel<StockItemSort> {
  row: StockItemRow;
  where: Prisma.Sql;
  orderBy: Prisma.Sql;
  query: StockItemsQuery;
  context: StockItemsScope;
}

type StockItemFilter =
  | 'category'
  | 'brand'
  | 'supplier'
  | 'country'
  | 'warehouse'
  | 'minPrice'
  | 'maxPrice'
  | 'minCost'
  | 'maxCost'
  | 'minQuantity'
  | 'maxQuantity'
  | 'expiresFrom'
  | 'expiresTo'
  | 'expiration';

const SKU = Prisma.sql`sku`;
const NAME = Prisma.sql`name`;
const CATEGORY = Prisma.sql`category`;
const BRAND = Prisma.sql`brand`;
const SUPPLIER = Prisma.sql`supplier`;
const COUNTRY = Prisma.sql`country`;
const WAREHOUSE = Prisma.sql`warehouse`;
const LOT = Prisma.sql`lot`;
const QUANTITY = Prisma.sql`quantity`;
const UNIT_COST = Prisma.sql`unit_cost_cents`;
const UNIT_PRICE = Prisma.sql`unit_price_cents`;
const MARGIN = Prisma.sql`(unit_price_cents - unit_cost_cents)`;
const EXPIRATION = Prisma.sql`expiration`;
const ID = Prisma.sql`id`;
const IMPORT_ID = Prisma.sql`import_id`;

const columns = listingColumns<StockItemRow, Prisma.Sql, Prisma.Sql>();

export const STOCK_ITEMS_LISTING: ListingDefinition<StockItemsListingModel, StockItemSort, StockItemFilter> = {
  sorts: {
    sku: columns.text({
      where: (comparison) => sqlCompare(SKU, comparison),
      orderBy: (order) => sqlOrder(SKU, order),
      read: (row) => row.sku,
    }),
    name: columns.text({
      where: (comparison) => sqlCompare(NAME, comparison),
      orderBy: (order) => sqlOrder(NAME, order),
      read: (row) => row.name,
    }),
    category: columns.text({
      where: (comparison) => sqlCompare(CATEGORY, comparison),
      orderBy: (order) => sqlOrder(CATEGORY, order),
      read: (row) => row.category,
    }),
    warehouse: columns.text({
      where: (comparison) => sqlCompare(WAREHOUSE, comparison),
      orderBy: (order) => sqlOrder(WAREHOUSE, order),
      read: (row) => row.warehouse,
    }),
    quantity: columns.number({
      where: (comparison) => sqlCompare(QUANTITY, comparison),
      orderBy: (order) => sqlOrder(QUANTITY, order),
      read: (row) => row.quantity,
    }),
    unitCost: columns.number({
      where: (comparison) => sqlCompare(UNIT_COST, comparison),
      orderBy: (order) => sqlOrder(UNIT_COST, order),
      read: (row) => row.unitCostCents,
    }),
    unitPrice: columns.number({
      where: (comparison) => sqlCompare(UNIT_PRICE, comparison),
      orderBy: (order) => sqlOrder(UNIT_PRICE, order),
      read: (row) => row.unitPriceCents,
    }),
    margin: columns.number({
      where: (comparison) => sqlCompare(MARGIN, comparison),
      orderBy: (order) => sqlOrder(MARGIN, order),
      read: (row) => row.unitPriceCents - row.unitCostCents,
    }),
    expiration: columns.calendar({
      where: (comparison) => sqlCompare(EXPIRATION, comparison, sqlDate),
      orderBy: (order) => sqlOrder(EXPIRATION, order, true),
      read: (row) => row.expiration,
      isNull: Prisma.sql`expiration IS NULL`,
    }),
  },
  id: columns.id({
    schema: z.number().int().positive(),
    where: (comparison) => sqlCompare(ID, comparison),
    orderBy: (order) => sqlOrder(ID, order),
    read: (row) => row.id,
  }),
  filters: {
    category: (values) => sqlIn(CATEGORY, values),
    brand: (values) => sqlIn(BRAND, values),
    supplier: (values) => sqlIn(SUPPLIER, values),
    country: (values) => sqlIn(COUNTRY, values),
    warehouse: (values) => sqlIn(WAREHOUSE, values),
    minPrice: (cents) => sqlCompare(UNIT_PRICE, { gte: cents }),
    maxPrice: (cents) => sqlCompare(UNIT_PRICE, { lte: cents }),
    minCost: (cents) => sqlCompare(UNIT_COST, { gte: cents }),
    maxCost: (cents) => sqlCompare(UNIT_COST, { lte: cents }),
    minQuantity: (quantity) => sqlCompare(QUANTITY, { gte: quantity }),
    maxQuantity: (quantity) => sqlCompare(QUANTITY, { lte: quantity }),
    expiresFrom: (day) => sqlCompare(EXPIRATION, { gte: day }, sqlCalendarDay),
    expiresTo: (day) => sqlCompare(EXPIRATION, { lte: day }, sqlCalendarDay),
    expiration: () => Prisma.sql`expiration IS NULL`,
  },
  created: (range) => Prisma.sql`${IMPORT_ID} IN (SELECT id FROM imports WHERE ${sqlInstantRange(Prisma.sql`created_at`, range)})`,
  search: {
    text: [
      (contains) => sqlContains(SKU, contains),
      (contains) => sqlContains(NAME, contains),
      (contains) => sqlContains(BRAND, contains),
      (contains) => sqlContains(SUPPLIER, contains),
      (contains) => sqlContains(LOT, contains),
    ],
    money: [(cents) => sqlCompare(UNIT_PRICE, { equals: cents }), (cents) => sqlCompare(UNIT_COST, { equals: cents })],
    dates: { kind: 'calendar', columns: [(match) => sqlCalendarMatch(EXPIRATION, match)] },
  },
  scope: (scope) => (scope.kind === 'import' ? Prisma.sql`${IMPORT_ID} = ${scope.importId}::uuid` : SQL_TRUE),
  and: sqlAnd,
  or: sqlOr,
  invalidCursor,
};

@Injectable()
export class StockItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly listing: ListingService,
    private readonly config: AppConfigService,
  ) {}

  async prepare(query: StockItemsQuery): Promise<StockItemsListing> {
    const cursor = this.listing.readCursor(STOCK_ITEMS_LISTING, query);

    if (query.importId === undefined) {
      const catalog = await this.prisma.import.aggregate({
        where: { status: 'completed' },
        _count: { _all: true },
        _max: { updatedAt: true },
        _sum: { itemCount: true },
      });
      return {
        query,
        cursor,
        scope: {
          kind: 'catalog',
          completedImports: catalog._count._all,
          lastChangeAt: catalog._max.updatedAt,
          itemCount: catalog._sum.itemCount ?? 0,
        },
      };
    }

    const found = await this.prisma.import.findUnique({
      where: { id: query.importId },
      select: { id: true, status: true, updatedAt: true, itemCount: true },
    });
    if (!found) {
      throw importNotFound();
    }
    if (found.status !== 'completed') {
      throw importNotCompleted();
    }

    return {
      query,
      cursor,
      scope: { kind: 'import', importId: found.id, updatedAt: found.updatedAt, itemCount: found.itemCount },
    };
  }

  version(scope: StockItemsScope): string[] {
    if (scope.kind === 'import') {
      return ['import', scope.importId, scope.updatedAt.toISOString()];
    }
    return ['catalog', String(scope.completedImports), scope.lastChangeAt?.toISOString() ?? 'empty'];
  }

  async list(listing: StockItemsListing): Promise<StockItemPage> {
    const { query, scope, cursor } = listing;
    const page = await this.listing.page(
      STOCK_ITEMS_LISTING,
      query,
      scope,
      {
        findMany: (args) => this.findRows(args.where, args.orderBy, args.take),
        dateBounds: async (where) => {
          const rows = await this.prisma.$queryRaw<unknown[]>`
            SELECT min(expiration) AS "min", max(expiration) AS "max" FROM stock_items WHERE ${where}
          `;
          const bounds = dateBoundsSchema.parse(rows[0]);
          return [bounds.min, bounds.max];
        },
        total: ({ where, narrowed, paged }) => this.total(scope, where, narrowed, paged),
      },
      cursor,
    );

    const snapshots = await this.snapshotsFor(page.rows);
    return {
      items: page.rows.map((row) => this.toStockItem(row, snapshots.get(row.importId) ?? null)),
      nextCursor: page.nextCursor,
      total: page.total,
    };
  }

  private async findRows(where: Prisma.Sql, orderBy: Prisma.Sql[], take: number): Promise<StockItemRow[]> {
    const ordering = orderBy.length === 0 ? Prisma.empty : Prisma.sql`ORDER BY ${Prisma.join(orderBy)}`;
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT
        id,
        import_id AS "importId",
        sku,
        name,
        category,
        brand,
        supplier,
        country,
        warehouse,
        lot,
        quantity,
        unit_cost_cents AS "unitCostCents",
        unit_price_cents AS "unitPriceCents",
        expiration
      FROM stock_items
      WHERE ${where}
      ${ordering}
      LIMIT ${take}
    `;
    return rows.map((row) => stockItemRowSchema.parse(row));
  }

  private async total(
    scope: StockItemsScope,
    where: Prisma.Sql,
    narrowed: boolean,
    paged: boolean,
  ): Promise<number | null> {
    if (paged) {
      return null;
    }
    if (!narrowed) {
      return scope.itemCount;
    }

    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT count(*)::int AS "total" FROM stock_items WHERE ${where}
    `;
    return countSchema.parse(rows[0]).total;
  }

  private async snapshotsFor(
    rows: StockItemRow[],
  ): Promise<Map<string, { rates: StockItemRates; values: Record<string, number> }>> {
    const importIds = [...new Set(rows.map((row) => row.importId))];
    if (importIds.length === 0) {
      return new Map();
    }

    const snapshots = await this.prisma.exchangeRateSnapshot.findMany({
      where: { importId: { in: importIds } },
      select: { importId: true, base: true, rateDate: true, source: true, rates: true },
    });

    return new Map(
      snapshots.map((snapshot) => [
        snapshot.importId,
        {
          rates: { base: snapshot.base, date: fromDbDate(snapshot.rateDate), source: snapshot.source },
          values: snapshotRatesSchema.parse(snapshot.rates),
        },
      ]),
    );
  }

  private toStockItem(
    row: StockItemRow,
    snapshot: { rates: StockItemRates; values: Record<string, number> } | null,
  ): StockItem {
    return {
      id: row.id,
      importId: row.importId,
      sku: row.sku,
      name: row.name,
      category: row.category,
      brand: row.brand,
      supplier: row.supplier,
      country: row.country,
      warehouse: row.warehouse,
      lot: row.lot,
      quantity: row.quantity,
      unitCostCents: row.unitCostCents,
      unitPriceCents: row.unitPriceCents,
      marginCents: row.unitPriceCents - row.unitCostCents,
      expiration: row.expiration === null ? null : fromDbDate(row.expiration),
      rates: snapshot?.rates ?? null,
      conversions: snapshot === null ? [] : this.conversions(row, snapshot.values),
    };
  }

  private conversions(row: StockItemRow, rates: Record<string, number>): StockItemConversion[] {
    const preferred = this.config.get('EXCHANGE_CURRENCIES');
    const rank = (currency: string): number => {
      const index = preferred.indexOf(currency);
      return index === -1 ? preferred.length : index;
    };

    return Object.entries(rates)
      .sort(([left], [right]) => rank(left) - rank(right) || left.localeCompare(right))
      .map(([currency, rate]) => ({
        currency,
        rate,
        unitCostCents: convertCents(row.unitCostCents, rate),
        unitPriceCents: convertCents(row.unitPriceCents, rate),
      }));
  }
}
