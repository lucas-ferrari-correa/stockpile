import { calendarDateSchema, moneyCentsSchema } from '@stockpile/shared';
import { z } from 'zod';

const LEAP_YEAR = 2000;

const wholeNumberSchema = z.coerce.number().pipe(z.int32().nonnegative());

export type SearchDate =
  | { kind: 'day'; year: number; month: number; day: number }
  | { kind: 'monthDay'; month: number; day: number }
  | { kind: 'month'; year: number; month: number };

export type ListingSearch = { kind: 'date'; date: SearchDate } | { kind: 'text'; term: string; pattern: string };

export interface CalendarSpan {
  from: string;
  to: string;
}

export interface YearRange {
  from: number;
  to: number;
}

export function isoDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function addDays(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function isRealDate(year: number, month: number, day: number): boolean {
  return calendarDateSchema.safeParse(isoDate(year, month, day)).success;
}

function calendarParts(year: string, month: string, day: string): { year: number; month: number; day: number } | null {
  if (year.length !== 4 || month.length === 0 || month.length > 2 || day.length === 0 || day.length > 2) {
    return null;
  }

  const parsed = calendarDateSchema.safeParse(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`);
  return parsed.success ? { year: Number(year), month: Number(month), day: Number(day) } : null;
}

function lastDayOfMonth(year: number, month: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month, 0);
  return date.getUTCDate();
}

function classifyDate(term: string): SearchDate | null {
  const parts = term.split('/');
  if (parts.length === 3) {
    const [month = '', day = '', year = ''] = parts;
    const date = calendarParts(year, month, day);
    return date === null ? null : { kind: 'day', ...date };
  }

  if (parts.length !== 2) {
    return null;
  }

  const [month = '', second = ''] = parts;
  if (second.length === 4) {
    const date = calendarParts(second, month, '1');
    return date === null ? null : { kind: 'month', year: date.year, month: date.month };
  }

  const date = calendarParts(String(LEAP_YEAR), month, second);
  return date === null ? null : { kind: 'monthDay', month: date.month, day: date.day };
}

export function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

export function classifySearch(term: string): ListingSearch {
  const date = classifyDate(term);
  return date === null ? { kind: 'text', term, pattern: escapeLike(term) } : { kind: 'date', date };
}

export function wholeNumber(term: string): number | null {
  const parsed = wholeNumberSchema.safeParse(term);
  return parsed.success && String(parsed.data) === term ? parsed.data : null;
}

export function moneyCents(term: string): number | null {
  const parsed = moneyCentsSchema.safeParse(term);
  return parsed.success ? parsed.data : null;
}

export function matchingValues<T extends string>(values: readonly T[], term: string): T[] {
  const needle = term.toLowerCase();
  return values.filter((value) => value.toLowerCase().includes(needle));
}

export function needsYears(date: SearchDate): boolean {
  return date.kind === 'monthDay';
}

export function searchSpans(date: SearchDate, years: YearRange | null): CalendarSpan[] {
  switch (date.kind) {
    case 'day': {
      const day = isoDate(date.year, date.month, date.day);
      return [{ from: day, to: day }];
    }

    case 'month':
      return [
        {
          from: isoDate(date.year, date.month, 1),
          to: isoDate(date.year, date.month, lastDayOfMonth(date.year, date.month)),
        },
      ];

    case 'monthDay': {
      if (years === null) {
        return [];
      }

      const spans: CalendarSpan[] = [];
      for (let year = years.from; year <= years.to; year += 1) {
        if (isRealDate(year, date.month, date.day)) {
          const day = isoDate(year, date.month, date.day);
          spans.push({ from: day, to: day });
        }
      }

      return spans;
    }
  }
}
