import { Readable } from 'node:stream';
import {
  INVENTORY_CSV_COLUMNS,
  INVENTORY_CSV_DELIMITER,
  INVENTORY_CSV_HEADER,
  InventoryCsvColumn,
  InventoryRejectionCode,
  InventoryRow,
  classifyInventoryCells,
  isInventoryCsvHeader,
} from '@stockpile/shared';
import { CsvError, parse } from 'csv-parse';
import { parse as parseSync } from 'csv-parse/sync';
import { z } from 'zod';
import { CsvLineTracker, trimLineBreaks } from './csv-line-tracker';

const RECORD_DELIMITERS = ['\r\n', '\n', '\r'];
const QUOTE = '"';

export interface AcceptedInventoryLine {
  ok: true;
  line: number;
  row: InventoryRow;
}

export interface RejectedInventoryLine {
  ok: false;
  line: number;
  field: InventoryCsvColumn | null;
  code: InventoryRejectionCode;
  message: string;
  raw: string;
}

export type ParsedInventoryLine = AcceptedInventoryLine | RejectedInventoryLine;

export class InvalidHeaderError extends Error {
  readonly code = 'INVALID_HEADER';

  constructor(received: readonly string[]) {
    super(`Expected header "${INVENTORY_CSV_HEADER}" but received "${received.join(INVENTORY_CSV_DELIMITER)}"`);
    this.name = 'InvalidHeaderError';
  }
}

const parsedRecordSchema = z.object({
  record: z.array(z.string()),
  raw: z.string(),
  info: z.object({ lines: z.number().int() }),
});

const quoteErrorSchema = z.object({
  code: z.string(),
  column: z.number().int().nonnegative().optional(),
});

interface PendingSkip {
  parserLine: number;
  raw: string;
  message: string;
}

function toPendingSkip(error: CsvError): PendingSkip {
  const lines: unknown = error.lines;
  const raw: unknown = error.raw;

  return {
    parserLine: typeof lines === 'number' ? lines : 0,
    raw: typeof raw === 'string' ? raw : '',
    message: error.message,
  };
}

function quoteViolation(raw: string): string | null {
  if (!raw.includes(QUOTE)) {
    return null;
  }

  try {
    parseSync(raw, {
      delimiter: INVENTORY_CSV_DELIMITER,
      record_delimiter: RECORD_DELIMITERS,
      relax_column_count: true,
    });
    return null;
  } catch (error: unknown) {
    const parsed = quoteErrorSchema.safeParse(error);
    if (!parsed.success) {
      throw error;
    }
    const { code, column } = parsed.data;
    const name = column === undefined ? undefined : INVENTORY_CSV_COLUMNS[column];

    return name === undefined ? `Invalid quote (${code})` : `Invalid quote in field "${name}" (${code})`;
  }
}

export async function* parseInventoryCsv(source: Readable): AsyncGenerator<ParsedInventoryLine> {
  const parser = parse({
    delimiter: INVENTORY_CSV_DELIMITER,
    record_delimiter: RECORD_DELIMITERS,
    bom: true,
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: true,
    skip_records_with_error: true,
    info: true,
    raw: true,
  });

  const skips: PendingSkip[] = [];
  parser.on('skip', (error: CsvError) => {
    skips.push(toPendingSkip(error));
  });
  source.on('error', (error: Error) => parser.destroy(error));
  source.pipe(parser);

  const lines = new CsvLineTracker();
  let headerSeen = false;

  function* drainSkips(beforeParserLine: number): Generator<RejectedInventoryLine> {
    let next = skips[0];

    while (next && next.parserLine < beforeParserLine) {
      skips.shift();
      const raw = trimLineBreaks(next.raw);

      if (!headerSeen) {
        throw new InvalidHeaderError([raw]);
      }

      yield {
        ok: false,
        line: lines.skippedStartLine(next.raw, next.parserLine),
        field: null,
        code: 'MALFORMED_ROW',
        message: next.message,
        raw,
      };
      next = skips[0];
    }
  }

  try {
    for await (const output of parser) {
      const chunk = parsedRecordSchema.parse(output);

      yield* drainSkips(chunk.info.lines);
      const line = lines.recordStartLine(chunk.record, chunk.info.lines);
      const raw = trimLineBreaks(chunk.raw);
      const violation = quoteViolation(raw);

      if (!headerSeen) {
        if (violation !== null) {
          throw new InvalidHeaderError([raw]);
        }
        if (!isInventoryCsvHeader(chunk.record)) {
          throw new InvalidHeaderError(chunk.record);
        }
        headerSeen = true;
        continue;
      }

      if (violation !== null) {
        yield { ok: false, line, field: null, code: 'MALFORMED_ROW', message: violation, raw };
        continue;
      }

      const result = classifyInventoryCells(chunk.record);
      if (result.ok) {
        yield { ok: true, line, row: result.row };
      } else {
        yield {
          ok: false,
          line,
          field: result.field,
          code: result.code,
          message: result.message,
          raw,
        };
      }
    }

    yield* drainSkips(Number.POSITIVE_INFINITY);
    if (!headerSeen) {
      throw new InvalidHeaderError([]);
    }
  } finally {
    source.destroy();
  }
}
