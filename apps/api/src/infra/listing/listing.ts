import { Injectable } from '@nestjs/common';
import { ListingQuery, SortOrder, calendarDateSchema } from '@stockpile/shared';
import { z } from 'zod';
import { fromDbDate, toDbDate } from '../dates/calendar-date';
import { decodeListingCursor, encodeListingCursor } from './listing-cursor';
import { YearRange, classifySearch, matchingValues, moneyCents, needsYears, searchSpans, wholeNumber } from './listing-search';
import { InstantBounds, InstantRange, yearsSpanning, zonedBounds, zonedRange } from './zoned-dates';

export type Comparison<V> = { gt: V } | { lt: V } | { gte: V } | { lte: V } | { equals: V };

export type CursorValue = string | number | null;

export interface ListingModel<S extends string = string> {
  row: unknown;
  where: unknown;
  orderBy: unknown;
  query: ListingQuery<S>;
  context: unknown;
}

type Bound<W> = { kind: 'value'; atOrAfter: W; after: W } | { kind: 'null' };

export interface SortColumn<R, W, O> {
  orderBy: (order: SortOrder) => O;
  read: (row: R) => CursorValue;
  isNull?: W;
  bound: (value: unknown, order: SortOrder) => Bound<W> | null;
}

export interface IdColumn<R, W, O> {
  orderBy: (order: SortOrder) => O;
  read: (row: R) => string | number;
  equals: (value: unknown) => W | null;
  after: (value: unknown, order: SortOrder) => W | null;
}

export interface TextContains {
  contains: string;
  mode: 'insensitive';
}

export type CalendarMatch = { in: Date[] } | { gte: Date; lte: Date };

export type DateSearch<W> =
  | { kind: 'instant'; columns: Array<(range: InstantRange) => W> }
  | { kind: 'calendar'; columns: Array<(match: CalendarMatch) => W> };

export interface SearchDefinition<W> {
  text: Array<(contains: TextContains) => W>;
  enums?: Array<(term: string) => W | null>;
  numbers?: Array<(value: number) => W>;
  money?: Array<(cents: number) => W>;
  dates?: DateSearch<W>;
}

export type ListingFilterKey<Q> = Exclude<keyof Q, keyof ListingQuery>;

export type ListingFilters<M extends ListingModel, F extends ListingFilterKey<M['query']>> = {
  [K in F]: (value: NonNullable<M['query'][K]>) => M['where'];
};

export interface ListingDefinition<
  M extends ListingModel<S>,
  S extends string,
  F extends ListingFilterKey<M['query']> = never,
> {
  sorts: Record<S, SortColumn<M['row'], M['where'], M['orderBy']>>;
  id: IdColumn<M['row'], M['where'], M['orderBy']>;
  filters: ListingFilters<M, F>;
  created?: (range: InstantBounds) => M['where'];
  search: SearchDefinition<M['where']>;
  scope: (context: M['context']) => M['where'];
  and: (parts: Array<M['where']>) => M['where'];
  or: (parts: Array<M['where']>) => M['where'];
  invalidCursor: () => Error;
}

export interface ListingTotalContext<W> {
  where: W;
  narrowed: boolean;
  paged: boolean;
}

export interface ListingSource<R, W, O> {
  findMany: (args: { where: W; orderBy: O[]; take: number }) => Promise<R[]>;
  dateBounds?: (where: W) => Promise<ReadonlyArray<Date | null | undefined>>;
  total?: (context: ListingTotalContext<W>) => Promise<number | null>;
}

export interface ListingCursor {
  sort: string;
  order: SortOrder;
  id: string | number;
}

export interface ListingPage<R> {
  rows: R[];
  nextCursor: string | null;
  total: number | null;
}

const listingCursorPayloadSchema = z.object({
  sort: z.string(),
  order: z.enum(['asc', 'desc']),
  id: z.union([z.string(), z.number()]),
});

function strictly<V>(order: SortOrder, value: V): Comparison<V> {
  return order === 'asc' ? { gt: value } : { lt: value };
}

function inclusive<V>(order: SortOrder, value: V): Comparison<V> {
  return order === 'asc' ? { gte: value } : { lte: value };
}

interface ColumnSpec<R, W, O, V, D> {
  schema: z.ZodType<V>;
  decode: (value: V) => D;
  read: (row: R) => CursorValue;
  where: (comparison: Comparison<D>) => W;
  orderBy: (order: SortOrder) => O;
  isNull?: W;
}

function sortColumn<R, W, O, V, D>(spec: ColumnSpec<R, W, O, V, D>): SortColumn<R, W, O> {
  return {
    orderBy: spec.orderBy,
    read: spec.read,
    isNull: spec.isNull,
    bound: (value, order) => {
      if (value === null) {
        return spec.isNull === undefined ? null : { kind: 'null' };
      }

      const parsed = spec.schema.safeParse(value);
      if (!parsed.success) {
        return null;
      }

      const decoded = spec.decode(parsed.data);
      return {
        kind: 'value',
        atOrAfter: spec.where(inclusive(order, decoded)),
        after: spec.where(strictly(order, decoded)),
      };
    },
  };
}

export interface ColumnOptions<R, W, O, T> {
  where: (comparison: Comparison<T>) => W;
  orderBy: (order: SortOrder) => O;
  read: (row: R) => T | null;
  isNull?: W;
}

export interface EnumSortOptions<R, W, O, E extends string> {
  values: readonly E[];
  where: (match: { in: E[] }) => W;
  orderBy: (order: SortOrder) => O;
  read: (row: R) => E;
}

export interface IdOptions<R, W, O, I extends string | number> {
  schema: z.ZodType<I>;
  where: (comparison: Comparison<I>) => W;
  orderBy: (order: SortOrder) => O;
  read: (row: R) => I;
}

export interface ListingColumns<R, W, O> {
  text: (options: ColumnOptions<R, W, O, string>) => SortColumn<R, W, O>;
  number: (options: ColumnOptions<R, W, O, number>) => SortColumn<R, W, O>;
  instant: (options: ColumnOptions<R, W, O, Date>) => SortColumn<R, W, O>;
  calendar: (options: ColumnOptions<R, W, O, Date>) => SortColumn<R, W, O>;
  enum: <E extends string>(options: EnumSortOptions<R, W, O, E>) => SortColumn<R, W, O>;
  id: <I extends string | number>(options: IdOptions<R, W, O, I>) => IdColumn<R, W, O>;
}

function enumColumn<R, W, O, E extends string>(options: EnumSortOptions<R, W, O, E>): SortColumn<R, W, O> {
  const schema = z.enum(options.values);
  const from = (value: E, order: SortOrder, strict: boolean): E[] => {
    const position = options.values.indexOf(value);
    return options.values.filter((_, index) =>
      order === 'asc'
        ? index > position || (!strict && index === position)
        : index < position || (!strict && index === position),
    );
  };

  return {
    orderBy: options.orderBy,
    read: options.read,
    bound: (value, order) => {
      const parsed = schema.safeParse(value);
      if (!parsed.success) {
        return null;
      }

      return {
        kind: 'value',
        atOrAfter: options.where({ in: from(parsed.data, order, false) }),
        after: options.where({ in: from(parsed.data, order, true) }),
      };
    },
  };
}

function idOf<R, W, O, I extends string | number>(options: IdOptions<R, W, O, I>): IdColumn<R, W, O> {
  return {
    orderBy: options.orderBy,
    read: options.read,
    equals: (value) => {
      const parsed = options.schema.safeParse(value);
      return parsed.success ? options.where({ equals: parsed.data }) : null;
    },
    after: (value, order) => {
      const parsed = options.schema.safeParse(value);
      return parsed.success ? options.where(strictly(order, parsed.data)) : null;
    },
  };
}

export function listingColumns<R, W, O>(): ListingColumns<R, W, O> {
  return {
    text: (options) => sortColumn({ ...options, schema: z.string(), decode: (value: string) => value }),
    number: (options) => sortColumn({ ...options, schema: z.number().int(), decode: (value: number) => value }),
    instant: (options) =>
      sortColumn({
        ...options,
        schema: z.iso.datetime(),
        decode: (value: string) => new Date(value),
        read: (row: R) => options.read(row)?.toISOString() ?? null,
      }),
    calendar: (options) =>
      sortColumn({
        ...options,
        schema: calendarDateSchema,
        decode: toDbDate,
        read: (row: R) => {
          const value = options.read(row);
          return value === null ? null : fromDbDate(value);
        },
      }),
    enum: enumColumn,
    id: idOf,
  };
}

export function enumSearch<W, E extends string>(
  values: readonly E[],
  where: (matched: E[]) => W,
): (term: string) => W | null {
  return (term) => {
    const matched = matchingValues(values, term);
    return matched.length === 0 ? null : where(matched);
  };
}

@Injectable()
export class ListingService {
  readCursor<M extends ListingModel<S>, S extends string, F extends ListingFilterKey<M['query']>>(
    definition: ListingDefinition<M, S, F>,
    query: M['query'],
  ): ListingCursor | null {
    if (query.cursor === undefined) {
      return null;
    }

    const cursor = decodeListingCursor(query.cursor, listingCursorPayloadSchema);
    if (
      cursor === null ||
      cursor.sort !== query.sort ||
      cursor.order !== query.order ||
      definition.id.equals(cursor.id) === null
    ) {
      throw definition.invalidCursor();
    }

    return cursor;
  }

  async page<M extends ListingModel<S>, S extends string, F extends ListingFilterKey<M['query']>>(
    definition: ListingDefinition<M, S, F>,
    query: M['query'],
    context: M['context'],
    source: ListingSource<M['row'], M['where'], M['orderBy']>,
    cursor: ListingCursor | null = this.readCursor(definition, query),
  ): Promise<ListingPage<M['row']>> {
    const scope = definition.scope(context);
    const filters = this.filterWhere(definition, query);
    const scoped = definition.and([scope, ...filters]);
    const search = await this.searchWhere(definition, query, scoped, source);
    const where = search === null ? scoped : definition.and([scoped, search]);
    const keyset = cursor === null ? null : await this.anchoredKeyset(definition, cursor, scope, source);
    const column = definition.sorts[query.sort];

    const [rows, total] = await Promise.all([
      source.findMany({
        where: keyset === null ? where : definition.and([where, keyset]),
        orderBy: [column.orderBy(query.order), definition.id.orderBy(query.order)],
        take: query.limit + 1,
      }),
      source.total === undefined
        ? Promise.resolve(null)
        : source.total({ where, narrowed: filters.length > 0 || search !== null, paged: cursor !== null }),
    ]);

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const next: ListingCursor | null =
      rows.length > query.limit && last !== undefined
        ? { sort: query.sort, order: query.order, id: definition.id.read(last) }
        : null;

    return { rows: page, nextCursor: next === null ? null : encodeListingCursor(next), total };
  }

  private filterWhere<M extends ListingModel<S>, S extends string, F extends ListingFilterKey<M['query']>>(
    definition: ListingDefinition<M, S, F>,
    query: M['query'],
  ): Array<M['where']> {
    const parts: Array<M['where']> = [];

    for (const key in definition.filters) {
      const value = query[key];
      if (value !== undefined && value !== null) {
        parts.push(definition.filters[key](value));
      }
    }

    const created = zonedBounds(query.createdFrom, query.createdTo, query.tz);
    if (created !== null && definition.created !== undefined) {
      parts.push(definition.created(created));
    }

    return parts;
  }

  private async searchWhere<M extends ListingModel<S>, S extends string, F extends ListingFilterKey<M['query']>>(
    definition: ListingDefinition<M, S, F>,
    query: M['query'],
    narrowed: M['where'],
    source: ListingSource<M['row'], M['where'], M['orderBy']>,
  ): Promise<M['where'] | null> {
    if (query.q === undefined) {
      return null;
    }

    const { search } = definition;
    const classified = classifySearch(query.q);

    if (classified.kind === 'text') {
      const contains: TextContains = { contains: classified.pattern, mode: 'insensitive' };
      const count = wholeNumber(classified.term);
      const cents = moneyCents(classified.term);

      return definition.or([
        ...search.text.map((column) => column(contains)),
        ...(search.enums ?? []).flatMap((column) => column(classified.term) ?? []),
        ...(count === null ? [] : (search.numbers ?? []).map((column) => column(count))),
        ...(cents === null ? [] : (search.money ?? []).map((column) => column(cents))),
      ]);
    }

    const dates = search.dates;
    if (dates === undefined) {
      return definition.or([]);
    }

    const zone = dates.kind === 'instant' ? query.tz : 'UTC';
    let years: YearRange | null = null;
    if (needsYears(classified.date) && source.dateBounds !== undefined) {
      years = yearsSpanning(await source.dateBounds(narrowed), zone);
    }

    const spans = searchSpans(classified.date, years);
    if (spans.length === 0) {
      return definition.or([]);
    }

    if (dates.kind === 'instant') {
      const ranges = spans.map((span) => zonedRange(span, zone));
      return definition.or(dates.columns.flatMap((column) => ranges.map((range) => column(range))));
    }

    const match: CalendarMatch[] = spans.every((span) => span.from === span.to)
      ? [{ in: spans.map((span) => toDbDate(span.from)) }]
      : spans.map((span) => ({ gte: toDbDate(span.from), lte: toDbDate(span.to) }));

    return definition.or(dates.columns.flatMap((column) => match.map((entry) => column(entry))));
  }

  private async anchoredKeyset<M extends ListingModel<S>, S extends string, F extends ListingFilterKey<M['query']>>(
    definition: ListingDefinition<M, S, F>,
    cursor: ListingCursor,
    scope: M['where'],
    source: ListingSource<M['row'], M['where'], M['orderBy']>,
  ): Promise<M['where']> {
    const byId = definition.id.equals(cursor.id);
    const [anchor] =
      byId === null ? [] : await source.findMany({ where: definition.and([scope, byId]), orderBy: [], take: 1 });
    const keyset = anchor === undefined ? null : this.keysetWhere(definition, cursor, anchor);

    if (keyset === null) {
      throw definition.invalidCursor();
    }

    return keyset;
  }

  private keysetWhere<M extends ListingModel<S>, S extends string, F extends ListingFilterKey<M['query']>>(
    definition: ListingDefinition<M, S, F>,
    cursor: ListingCursor,
    anchor: M['row'],
  ): M['where'] | null {
    const column = Object.entries<SortColumn<M['row'], M['where'], M['orderBy']>>(definition.sorts).find(
      ([key]) => key === cursor.sort,
    )?.[1];
    const idAfter = definition.id.after(cursor.id, cursor.order);
    const bound = column?.bound(column.read(anchor), cursor.order) ?? null;

    if (column === undefined || idAfter === null || bound === null) {
      return null;
    }

    if (bound.kind === 'null') {
      return column.isNull === undefined ? null : definition.and([column.isNull, idAfter]);
    }

    const ranked = definition.and([bound.atOrAfter, definition.or([bound.after, idAfter])]);
    return column.isNull === undefined ? ranked : definition.or([ranked, column.isNull]);
  }
}
