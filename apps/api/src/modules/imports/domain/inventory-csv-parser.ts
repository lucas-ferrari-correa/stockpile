import { Readable } from 'node:stream';
import {
  INVENTORY_CSV_DELIMITER,
  INVENTORY_CSV_HEADER,
  InventoryCsvColumn,
  InventoryRejectionCode,
  InventoryRow,
  classifyInventoryCells,
  isInventoryCsvHeader,
} from '@stockpile/shared';
import { CsvError, parse } from 'csv-parse';
import { z } from 'zod';
import { CsvLineTracker, trimLineBreaks } from './csv-line-tracker';

const RECORD_DELIMITERS = ['\r\n', '\n', '\r'];

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

      if (!headerSeen) {
        if (!isInventoryCsvHeader(chunk.record)) {
          throw new InvalidHeaderError(chunk.record);
        }
        headerSeen = true;
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
          raw: trimLineBreaks(chunk.raw),
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
