import { CalendarSpan, YearRange, addDays, isoDate } from './listing-search';

export interface InstantRange {
  gte: Date;
  lt: Date;
}

export interface InstantBounds {
  gte?: Date;
  lt?: Date;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached !== undefined) {
    return cached;
  }
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  formatters.set(timeZone, created);
  return created;
}

function localParts(instant: number, timeZone: string): LocalParts {
  const parts = formatter(timeZone).formatToParts(new Date(instant));
  const value = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value);

  return { year: value('year'), month: value('month'), day: value('day'), hour: value('hour'), minute: value('minute'), second: value('second') };
}

function utcMillis(parts: LocalParts): number {
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour, parts.minute, parts.second, 0);

  return date.getTime();
}

function offsetAt(instant: number, timeZone: string): number {
  const whole = Math.floor(instant / 1000) * 1000;

  return utcMillis(localParts(whole, timeZone)) - whole;
}

export function zonedDate(instant: Date, timeZone: string): string {
  const parts = localParts(instant.getTime(), timeZone);
  return isoDate(parts.year, parts.month, parts.day);
}

export function zonedYear(instant: Date, timeZone: string): number {
  return localParts(instant.getTime(), timeZone).year;
}

export function zonedDayStart(date: string, timeZone: string): Date {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  const guess = utcMillis({ year, month, day, hour: 0, minute: 0, second: 0 });

  const first = guess - offsetAt(guess, timeZone);
  const second = guess - offsetAt(first, timeZone);
  const candidates = [first, second].sort((left, right) => left - right);
  const start = candidates.find((candidate) => zonedDate(new Date(candidate), timeZone) === date) ?? Math.max(first, second);

  return new Date(start);
}

export function zonedRange(span: CalendarSpan, timeZone: string): InstantRange {
  return { gte: zonedDayStart(span.from, timeZone), lt: zonedDayStart(addDays(span.to, 1), timeZone) };
}

export function zonedBounds(from: string | undefined, to: string | undefined, timeZone: string): InstantBounds | null {
  if (from === undefined && to === undefined) {
    return null;
  }

  return {
    ...(from === undefined ? {} : { gte: zonedDayStart(from, timeZone) }),
    ...(to === undefined ? {} : { lt: zonedDayStart(addDays(to, 1), timeZone) }),
  };
}

export function yearsSpanning(instants: ReadonlyArray<Date | null | undefined>, timeZone: string): YearRange | null {
  const years = instants.filter((instant): instant is Date => instant instanceof Date).map((instant) => zonedYear(instant, timeZone));
  return years.length === 0 ? null : { from: Math.min(...years), to: Math.max(...years) };
}
