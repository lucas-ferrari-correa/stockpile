import { Readable } from 'node:stream';
import { INVENTORY_CSV_HEADER } from '@stockpile/shared';
import { InvalidHeaderError, ParsedInventoryLine, parseInventoryCsv } from './inventory-csv-parser';

interface RowCells {
  sku: string;
  name: string;
  brand: string;
  quantity: string;
  unitCost: string;
  unitPrice: string;
  expiration: string;
}

const DEFAULT_CELLS: RowCells = {
  sku: 'SKU-1',
  name: 'Widget',
  brand: 'Acme',
  quantity: '5',
  unitCost: '1.25',
  unitPrice: '2.50',
  expiration: '3/4/2030',
};

function row(overrides: Partial<RowCells> = {}): string {
  const cells: RowCells = { ...DEFAULT_CELLS, ...overrides };
  return [
    cells.sku,
    cells.name,
    'Tools',
    cells.brand,
    'Supplier Inc',
    'US',
    'WH-1',
    'LOT-1',
    cells.quantity,
    cells.unitCost,
    cells.unitPrice,
    cells.expiration,
  ].join(';');
}

async function collect(source: Readable): Promise<ParsedInventoryLine[]> {
  const parsed: ParsedInventoryLine[] = [];
  for await (const line of parseInventoryCsv(source)) {
    parsed.push(line);
  }
  return parsed;
}

function parseText(content: string | Buffer): Promise<ParsedInventoryLine[]> {
  return collect(Readable.from([Buffer.isBuffer(content) ? content : Buffer.from(content)]));
}

function parseByteByByte(content: string): Promise<ParsedInventoryLine[]> {
  const bytes = Buffer.from(content);
  return collect(Readable.from(Array.from({ length: bytes.length }, (_, index) => bytes.subarray(index, index + 1))));
}

function summary(parsed: readonly ParsedInventoryLine[]): Array<[number, string]> {
  return parsed.map((line) => [line.line, line.ok ? 'accepted' : line.code]);
}

function accepted(parsed: readonly ParsedInventoryLine[]): ParsedInventoryLine & { ok: true } {
  const [first] = parsed;
  if (first === undefined || !first.ok) {
    throw new Error(`Expected a single accepted line, got ${JSON.stringify(parsed)}`);
  }
  return first;
}

describe('parseInventoryCsv', () => {
  it('ignores a UTF-8 byte order mark before the header', async () => {
    const parsed = await parseText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${INVENTORY_CSV_HEADER}\n${row()}\n`)]));

    expect(summary(parsed)).toEqual([[2, 'accepted']]);
    expect(accepted(parsed).row.sku).toBe('SKU-1');
  });

  it('reports the physical line of each record across mixed CRLF, LF and CR endings', async () => {
    const content = [
      `${INVENTORY_CSV_HEADER}\r\n`,
      `${row({ sku: 'A' })}\n`,
      `${row({ sku: 'B', unitCost: 'abc' })}\r`,
      `${row({ sku: 'C' })}\r\n`,
      `${row({ sku: 'D', quantity: '-1' })}\n`,
      row({ sku: 'E' }),
    ].join('');

    const parsed = await parseText(content);

    expect(summary(parsed)).toEqual([
      [2, 'accepted'],
      [3, 'INVALID_MONEY'],
      [4, 'accepted'],
      [5, 'INVALID_QUANTITY'],
      [6, 'accepted'],
    ]);
  });

  it('keeps line breaks inside quoted fields and counts their physical lines for later records', async () => {
    const content = [
      INVENTORY_CSV_HEADER,
      row({ name: '"First\r\nsecond\nthird"' }),
      row({ sku: 'X', unitPrice: 'bad' }),
      '',
    ].join('\r\n');

    const parsed = await parseText(content);

    expect(summary(parsed)).toEqual([
      [2, 'accepted'],
      [5, 'INVALID_MONEY'],
    ]);
    expect(accepted(parsed).row.name).toBe('First\r\nsecond\nthird');
  });

  it('points a rejected multi-line record at its first physical line and keeps its raw text', async () => {
    const multiLine = row({ name: '"Two\nlines"', expiration: '2/30/2030' });
    const content = `${INVENTORY_CSV_HEADER}\n\n${multiLine}\n${row()}\n`;

    const parsed = await parseText(content);

    expect(summary(parsed)).toEqual([
      [3, 'INVALID_DATE'],
      [5, 'accepted'],
    ]);
    expect(parsed[0]).toMatchObject({ field: 'expiration', raw: multiLine });
  });

  it('produces the same lines when the stream arrives one byte at a time', async () => {
    const content = [
      `\uFEFF${INVENTORY_CSV_HEADER}\r\n`,
      `${row({ name: '"Multi\r\nline ⚙️"' })}\r`,
      `${row({ quantity: 'x' })}\n`,
      `${row({ name: '"bro"ken"' })}\r\n`,
      `\r\n`,
      `${row()};extra\n`,
      row(),
    ].join('');

    expect(await parseByteByByte(content)).toEqual(await parseText(content));
  });

  it('accepts a stray quote inside an unquoted field as a literal character', async () => {
    const parsed = await parseText(`${INVENTORY_CSV_HEADER}\n${row({ name: '12" ruler', brand: 'O"Brien' })}\n`);

    expect(accepted(parsed).row).toMatchObject({ name: '12" ruler', brand: 'O"Brien' });
  });

  it('unescapes doubled quotes and keeps the delimiter inside a quoted field', async () => {
    const parsed = await parseText(`${INVENTORY_CSV_HEADER}\n${row({ name: '"Say ""hi""; then leave"' })}\n`);

    expect(accepted(parsed).row.name).toBe('Say "hi"; then leave');
  });

  it.each<[string, string]>([
    ['one column missing', row().split(';').slice(0, 11).join(';')],
    ['one column extra', `${row()};extra`],
    ['a single cell', 'lonely'],
  ])('rejects a record with %s as a column count error with its raw line', async (_label, record) => {
    const parsed = await parseText(`${INVENTORY_CSV_HEADER}\n${row()}\n${record}\n${row()}\n`);

    expect(summary(parsed)).toEqual([
      [2, 'accepted'],
      [3, 'COLUMN_COUNT'],
      [4, 'accepted'],
    ]);
    expect(parsed[1]).toMatchObject({ field: null, raw: record });
  });

  it('keeps text after a closing quote literally instead of rejecting the row', async () => {
    const parsed = await parseText(`${INVENTORY_CSV_HEADER}\n${row({ name: '"Closed"tail' })}\n${row({ sku: 'NEXT' })}\n`);

    expect(summary(parsed)).toEqual([
      [2, 'accepted'],
      [3, 'accepted'],
    ]);
    expect(accepted(parsed).row.name).toBe('"Closed"tail');
  });

  it('rejects a quote left open until the end of the file as one malformed row starting at its physical line', async () => {
    const parsed = await parseText(`${INVENTORY_CSV_HEADER}\n${row()}\n\n${row({ name: '"never closed' })}\n${row()}\n`);

    expect(summary(parsed)).toEqual([
      [2, 'accepted'],
      [4, 'MALFORMED_ROW'],
    ]);
    expect(parsed[1]).toMatchObject({ field: null, raw: `${row({ name: '"never closed' })}\n${row()}` });
    expect(parsed[1]?.ok === false && parsed[1].message).toMatch(/quote/i);
  });

  it('skips blank lines without counting them as records while keeping physical line numbers', async () => {
    const parsed = await parseText(`\n${INVENTORY_CSV_HEADER}\n\n\r\n${row()}\n\n`);

    expect(summary(parsed)).toEqual([[5, 'accepted']]);
  });

  it('yields nothing for a file holding only the header', async () => {
    expect(await parseText(`${INVENTORY_CSV_HEADER}\r\n`)).toEqual([]);
  });

  it.each<[string, string]>([
    ['an empty file', ''],
    ['only blank lines', '\n\r\n\n'],
    ['only a byte order mark', '\uFEFF'],
    ['a data row instead of the header', `${row()}\n${row()}\n`],
    ['a header with one column missing', `${INVENTORY_CSV_HEADER.split(';').slice(0, 11).join(';')}\n${row()}\n`],
    ['a header with an extra column', `${INVENTORY_CSV_HEADER};extra\n${row()}\n`],
    ['a header in another case', `${INVENTORY_CSV_HEADER.toUpperCase()}\n${row()}\n`],
    ['a header with padded names', `${INVENTORY_CSV_HEADER.replace('sku', ' sku')}\n${row()}\n`],
    ['a comma separated header', `${INVENTORY_CSV_HEADER.replaceAll(';', ',')}\n${row()}\n`],
    ['a malformed header', `"sku"x;${INVENTORY_CSV_HEADER.slice(4)}\n${row()}\n`],
  ])('fails the whole file with an invalid header error for %s', async (_label, content) => {
    await expect(parseText(content)).rejects.toBeInstanceOf(InvalidHeaderError);
  });

  it('exposes the invalid header code and the received header in the error', async () => {
    const error: unknown = await parseText('a;b;c\n').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(InvalidHeaderError);
    expect(error).toMatchObject({ code: 'INVALID_HEADER', message: expect.stringContaining('"a;b;c"') as string });
  });

  it.each<[string, number]>([
    ['0.29', 29],
    ['1.15', 115],
    ['19.99', 1999],
    ['4.35', 435],
    ['0.07', 7],
  ])('converts the amount %s to exact integer cents', async (amount, cents) => {
    const parsed = await parseText(`${INVENTORY_CSV_HEADER}\n${row({ unitCost: amount, unitPrice: amount })}\n`);

    expect(accepted(parsed).row).toMatchObject({ unit_cost: cents, unit_price: cents });
  });

  it('rejects an amount with sub-cent precision instead of rounding it', async () => {
    const parsed = await parseText(`${INVENTORY_CSV_HEADER}\n${row({ unitCost: '1.005' })}\n`);

    expect(parsed).toEqual([expect.objectContaining({ ok: false, line: 2, field: 'unit_cost', code: 'INVALID_MONEY' })]);
  });

  it('maps an empty expiration to null', async () => {
    const parsed = await parseText(`${INVENTORY_CSV_HEADER}\n${row({ expiration: '' })}\n`);

    expect(accepted(parsed).row.expiration).toBeNull();
  });

  it.each<[string, string]>([
    ['1/1/2030', '2030-01-01'],
    ['12/31/2030', '2030-12-31'],
    ['2/29/2028', '2028-02-29'],
  ])('keeps the calendar day of the expiration %s whatever the process time zone', async (input, iso) => {
    const parsed = await parseText(`${INVENTORY_CSV_HEADER}\n${row({ expiration: input })}\n`);

    expect(accepted(parsed).row.expiration).toBe(iso);
  });

  it('keeps unicode text byte for byte', async () => {
    const name = 'Café\u200bÑandú 🧀 Ω ﷽';
    const parsed = await parseText(`${INVENTORY_CSV_HEADER}\n${row({ name })}\n`);

    expect(Buffer.compare(Buffer.from(accepted(parsed).row.name), Buffer.from(name))).toBe(0);
  });
});
