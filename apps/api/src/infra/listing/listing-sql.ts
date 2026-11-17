import { Prisma } from '@prisma/client';
import { SortOrder } from '@stockpile/shared';
import { fromDbDate } from '../dates/calendar-date';
import { CalendarMatch, Comparison, TextContains } from './listing';
import { InstantBounds, InstantRange } from './zoned-dates';

export const SQL_TRUE = Prisma.sql`TRUE`;

export const SQL_FALSE = Prisma.sql`FALSE`;

export function sqlAnd(parts: Prisma.Sql[]): Prisma.Sql {
  if (parts.length === 0) {
    return SQL_TRUE;
  }

  return Prisma.join(
    parts.map((part) => Prisma.sql`(${part})`),
    ' AND ',
  );
}

export function sqlOr(parts: Prisma.Sql[]): Prisma.Sql {
  if (parts.length === 0) {
    return SQL_FALSE;
  }

  return Prisma.join(
    parts.map((part) => Prisma.sql`(${part})`),
    ' OR ',
  );
}

export function sqlCompare<V>(
  column: Prisma.Sql,
  comparison: Comparison<V>,
  value: (raw: V) => Prisma.Sql = (raw) => Prisma.sql`${raw}`,
): Prisma.Sql {
  if ('gt' in comparison) {
    return Prisma.sql`${column} > ${value(comparison.gt)}`;
  }
  if ('lt' in comparison) {
    return Prisma.sql`${column} < ${value(comparison.lt)}`;
  }
  if ('gte' in comparison) {
    return Prisma.sql`${column} >= ${value(comparison.gte)}`;
  }
  if ('lte' in comparison) {
    return Prisma.sql`${column} <= ${value(comparison.lte)}`;
  }

  return Prisma.sql`${column} = ${value(comparison.equals)}`;
}

export function sqlDate(date: Date): Prisma.Sql {
  return Prisma.sql`${fromDbDate(date)}::date`;
}

export function sqlCalendarDay(day: string): Prisma.Sql {
  return Prisma.sql`${day}::date`;
}

export function sqlInstant(instant: Date): Prisma.Sql {
  return Prisma.sql`${instant.toISOString()}::timestamptz`;
}

export function sqlOrder(column: Prisma.Sql, order: SortOrder, nullable = false): Prisma.Sql {
  const direction = order === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  return nullable ? Prisma.sql`${column} ${direction} NULLS LAST` : Prisma.sql`${column} ${direction}`;
}

export function sqlContains(column: Prisma.Sql, contains: TextContains): Prisma.Sql {
  return Prisma.sql`${column} ILIKE ${`%${contains.contains}%`}`;
}

export function sqlIn<V>(column: Prisma.Sql, values: readonly V[]): Prisma.Sql {
  if (values.length === 0) {
    return SQL_FALSE;
  }

  return Prisma.sql`${column} IN (${Prisma.join(values)})`;
}

export function sqlCalendarMatch(column: Prisma.Sql, match: CalendarMatch): Prisma.Sql {
  if ('in' in match) {
    return match.in.length === 0
      ? SQL_FALSE
      : Prisma.sql`${column} IN (${Prisma.join(match.in.map((date) => sqlDate(date)))})`;
  }

  return Prisma.sql`${column} BETWEEN ${sqlDate(match.gte)} AND ${sqlDate(match.lte)}`;
}

export function sqlInstantRange(column: Prisma.Sql, range: InstantBounds | InstantRange): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (range.gte !== undefined) {
    parts.push(Prisma.sql`${column} >= ${sqlInstant(range.gte)}`);
  }
  if (range.lt !== undefined) {
    parts.push(Prisma.sql`${column} < ${sqlInstant(range.lt)}`);
  }

  return sqlAnd(parts);
}
