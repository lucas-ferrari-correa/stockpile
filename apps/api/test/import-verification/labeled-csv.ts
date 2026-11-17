import {
  INVENTORY_CSV_DELIMITER,
  INVENTORY_CSV_HEADER,
  InventoryCsvColumn,
  InventoryRejectionCode,
  NUL_CHARACTER,
  RejectedByReason,
  inventoryIdentityKey,
} from '@stockpile/shared';
import { stringify } from 'csv-stringify/sync';

export type Eol = '\n' | '\r\n' | '\r';

export type RowExpectation = 'accepted' | InventoryRejectionCode;

export type InventoryCells = Record<InventoryCsvColumn, string>;

export interface ExpectedItem {
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

export type LabeledRow =
  | { expected: 'accepted'; record: string; item: ExpectedItem }
  | { expected: InventoryRejectionCode; record: string; field: InventoryCsvColumn | null }
  | { expected: 'blank' };

export interface LabeledLine {
  row: LabeledRow;
  eol: Eol | '';
}

export interface ExpectedRejection {
  line: number;
  field: InventoryCsvColumn | null;
  code: InventoryRejectionCode;
  raw: string;
}

export interface LabeledCsv {
  content: string;
  total: number;
  acceptedRows: number;
  rejections: ExpectedRejection[];
  rejectedByReason: RejectedByReason;
  catalog: ExpectedItem[];
  lineOf: Map<LabeledRow, number>;
}

const STORED_NUL_REPLACEMENT = '�';
const BYTE_ORDER_MARK = '﻿';
const LINE_BREAK = /\r\n|\r|\n/g;

export function csvRecord(cells: readonly string[]): string {
  return stringify([[...cells]], { delimiter: INVENTORY_CSV_DELIMITER, eof: false });
}

export function cellsOf(cells: InventoryCells): string[] {
  return [
    cells.sku,
    cells.name,
    cells.category,
    cells.brand,
    cells.supplier,
    cells.country,
    cells.warehouse,
    cells.lot,
    cells.quantity,
    cells.unit_cost,
    cells.unit_price,
    cells.expiration,
  ];
}

export function physicalBreaks(text: string): number {
  return text.match(LINE_BREAK)?.length ?? 0;
}

export function identityOrder(left: ExpectedItem, right: ExpectedItem): number {
  const a = inventoryIdentityKey(left);
  const b = inventoryIdentityKey(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function buildLabeledCsv(lines: readonly LabeledLine[], options: { bom?: boolean; headerEol?: Eol } = {}): LabeledCsv {
  const parts: string[] = [options.bom ? BYTE_ORDER_MARK : '', INVENTORY_CSV_HEADER, options.headerEol ?? '\n'];
  const rejections: ExpectedRejection[] = [];
  const rejectedByReason: RejectedByReason = {};
  const catalog = new Map<string, ExpectedItem>();
  const lineOf = new Map<LabeledRow, number>();
  let total = 0;
  let acceptedRows = 0;
  let line = 2;

  for (const { row, eol } of lines) {
    const record = row.expected === 'blank' ? '' : row.record;
    parts.push(record, eol);
    lineOf.set(row, line);

    if (row.expected === 'accepted') {
      total += 1;
      acceptedRows += 1;
      catalog.set(inventoryIdentityKey(row.item), row.item);
    } else if (row.expected !== 'blank') {
      total += 1;
      rejections.push({ line, field: row.field, code: row.expected, raw: record.replaceAll(NUL_CHARACTER, STORED_NUL_REPLACEMENT) });
      rejectedByReason[row.expected] = (rejectedByReason[row.expected] ?? 0) + 1;
    }

    line += physicalBreaks(record) + (eol === '' ? 0 : 1);
  }

  return {
    content: parts.join(''),
    total,
    acceptedRows,
    rejections,
    rejectedByReason,
    catalog: [...catalog.values()].sort(identityOrder),
    lineOf,
  };
}
