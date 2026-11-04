import { describe, expect, it } from 'vitest';
import {
  INVENTORY_CSV_COLUMNS,
  INVENTORY_CSV_DELIMITER,
  INVENTORY_CSV_HEADER,
  type InventoryCsvColumn,
  type InventoryRejectionCode,
  type InventoryRow,
  classifyInventoryCells,
  inventoryIdentityKey,
  isInventoryCsvHeader,
} from './contract';

type CanonicalRecord = Record<InventoryCsvColumn, string>;

const CANONICAL: CanonicalRecord = {
  sku: 'DAI-000001',
  name: 'Whole Milk 2L',
  category: 'Dairy',
  brand: 'Northwind',
  supplier: 'Atlas Trading Ltd.',
  country: 'BR',
  warehouse: 'WH-SAO-01',
  lot: 'L202601-0001',
  quantity: '10',
  unit_cost: '6.56',
  unit_price: '7.71',
  expiration: '12/31/2026',
};

function cellsWith(overrides: Partial<CanonicalRecord> = {}): string[] {
  const record: CanonicalRecord = { ...CANONICAL, ...overrides };
  return INVENTORY_CSV_COLUMNS.map((column) => record[column]);
}

function acceptedRow(overrides: Partial<CanonicalRecord>): InventoryRow {
  const result = classifyInventoryCells(cellsWith(overrides));
  if (!result.ok) {
    throw new Error(`Expected acceptance but got ${result.code} on ${String(result.field)}: ${result.message}`);
  }
  return result.row;
}

const REQUIRED_COLUMNS: readonly InventoryCsvColumn[] = INVENTORY_CSV_COLUMNS.filter(
  (column) => column !== 'brand' && column !== 'expiration',
);

describe('inventory CSV header', () => {
  it('lists the twelve columns in contract order joined by semicolons', () => {
    expect(INVENTORY_CSV_DELIMITER).toBe(';');
    expect(INVENTORY_CSV_HEADER).toBe(
      'sku;name;category;brand;supplier;country;warehouse;lot;quantity;unit_cost;unit_price;expiration',
    );
    expect(isInventoryCsvHeader(INVENTORY_CSV_HEADER.split(INVENTORY_CSV_DELIMITER))).toBe(true);
  });

  it.each<[string, string[]]>([
    ['permuted columns', ['name', 'sku', ...INVENTORY_CSV_COLUMNS.slice(2)]],
    ['a missing column', INVENTORY_CSV_COLUMNS.slice(0, -1)],
    ['upper case names', INVENTORY_CSV_COLUMNS.map((column) => column.toUpperCase())],
  ])('rejects a header with %s', (_label, cells) => {
    expect(isInventoryCsvHeader(cells)).toBe(false);
  });
});

describe('classifyInventoryCells', () => {
  it('accepts the canonical row converting money to integer cents and the date to ISO', () => {
    expect(acceptedRow({})).toEqual({
      sku: 'DAI-000001',
      name: 'Whole Milk 2L',
      category: 'Dairy',
      brand: 'Northwind',
      supplier: 'Atlas Trading Ltd.',
      country: 'BR',
      warehouse: 'WH-SAO-01',
      lot: 'L202601-0001',
      quantity: 10,
      unit_cost: 656,
      unit_price: 771,
      expiration: '2026-12-31',
    });
  });

  it.each<[Partial<CanonicalRecord>, Partial<InventoryRow>]>([
    [{ sku: 'S'.repeat(64) }, { sku: 'S'.repeat(64) }],
    [{ brand: '' }, { brand: null }],
    [{ brand: '   ' }, { brand: null }],
    [{ quantity: '0' }, { quantity: 0 }],
    [{ quantity: '2147483647' }, { quantity: 2147483647 }],
    [{ unit_cost: '0' }, { unit_cost: 0 }],
    [{ unit_cost: '$1.5' }, { unit_cost: 150 }],
    [{ unit_cost: '10.25' }, { unit_cost: 1025 }],
    [{ unit_cost: '1.' }, { unit_cost: 100 }],
    [{ unit_cost: '.5' }, { unit_cost: 50 }],
    [{ unit_price: '21474836.47' }, { unit_price: 2147483647 }],
    [{ unit_cost: '9.99', unit_price: '1.00' }, { unit_cost: 999, unit_price: 100 }],
    [{ expiration: '2/29/2024' }, { expiration: '2024-02-29' }],
    [{ expiration: '' }, { expiration: null }],
    [{ name: 'Café Ñandú 🧀 "Brie"; 1kg' }, { name: 'Café Ñandú 🧀 "Brie"; 1kg' }],
  ])('accepts the boundary value %j', (overrides, expected) => {
    expect(acceptedRow(overrides)).toMatchObject(expected);
  });

  it.each<[Partial<CanonicalRecord>, InventoryCsvColumn, InventoryRejectionCode]>([
    [{ sku: 'S'.repeat(65) }, 'sku', 'INVALID_LENGTH'],
    [{ country: 'br' }, 'country', 'INVALID_COUNTRY'],
    [{ country: 'XX' }, 'country', 'INVALID_COUNTRY'],
    [{ country: 'BRA' }, 'country', 'INVALID_COUNTRY'],
    [{ quantity: '-1' }, 'quantity', 'INVALID_QUANTITY'],
    [{ quantity: '1.5' }, 'quantity', 'INVALID_QUANTITY'],
    [{ quantity: '2147483648' }, 'quantity', 'INVALID_QUANTITY'],
    [{ unit_cost: '1.234' }, 'unit_cost', 'INVALID_MONEY'],
    [{ unit_cost: '007.5' }, 'unit_cost', 'INVALID_MONEY'],
    [{ unit_cost: '-1' }, 'unit_cost', 'INVALID_MONEY'],
    [{ unit_price: 'abc' }, 'unit_price', 'INVALID_MONEY'],
    [{ unit_price: '21474836.48' }, 'unit_price', 'INVALID_MONEY'],
    [{ expiration: '2/29/2023' }, 'expiration', 'INVALID_DATE'],
    [{ expiration: '2024-02-29' }, 'expiration', 'INVALID_DATE'],
    [{ expiration: '13/1/2024' }, 'expiration', 'INVALID_DATE'],
    [{ lot: 'L1\u0000' }, 'lot', 'INVALID_CHARACTER'],
    [{ brand: '\u0000' }, 'brand', 'INVALID_CHARACTER'],
  ])('rejects %j on %s with %s', (overrides, field, code) => {
    expect(classifyInventoryCells(cellsWith(overrides))).toMatchObject({ ok: false, field, code });
  });

  it.each(REQUIRED_COLUMNS.flatMap((column) => [[column, ''] as const, [column, '  '] as const]))(
    'rejects %s set to %j as a missing field',
    (column, value) => {
      expect(classifyInventoryCells(cellsWith({ [column]: value }))).toMatchObject({
        ok: false,
        field: column,
        code: 'MISSING_FIELD',
      });
    },
  );

  it.each([11, 13])('rejects a row with %i cells as a column count error', (size) => {
    const cells = size < 12 ? cellsWith().slice(0, size) : [...cellsWith(), 'extra'];
    expect(classifyInventoryCells(cells)).toMatchObject({ ok: false, field: null, code: 'COLUMN_COUNT' });
  });
});

describe('inventoryIdentityKey', () => {
  it('maps the same sku, warehouse and lot to the same key regardless of other attributes', () => {
    const first = acceptedRow({ quantity: '1' });
    const second = acceptedRow({ quantity: '2', name: 'Renamed' });
    expect(inventoryIdentityKey(first)).toBe(inventoryIdentityKey(second));
  });

  it('distinguishes identities that differ only by lot', () => {
    expect(inventoryIdentityKey({ sku: 'A', warehouse: 'W', lot: 'L1' })).not.toBe(
      inventoryIdentityKey({ sku: 'A', warehouse: 'W', lot: 'L2' }),
    );
  });

  it('does not collide when a delimiter-like character shifts between components', () => {
    expect(inventoryIdentityKey({ sku: 'A|B', warehouse: 'W', lot: 'L' })).not.toBe(
      inventoryIdentityKey({ sku: 'A', warehouse: 'B|W', lot: 'L' }),
    );
  });
});
