import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'csv-parse/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  INVENTORY_CSV_COLUMNS,
  INVENTORY_CSV_DELIMITER,
  INVENTORY_REJECTION_CODES,
  type InventoryRejectionCode,
  classifyInventoryCells,
  inventoryIdentityKey,
  isInventoryCsvHeader,
} from './contract';

interface DatasetManifest {
  seed: number;
  rows: number;
  total: number;
  accepted: number;
  rejected: number;
  rejectedByReason: Record<InventoryRejectionCode, number>;
  distinctIdentities: number;
  expectedCreated: number;
  expectedUpdated: number;
}

interface ReconciledCounts {
  headerValid: boolean;
  total: number;
  accepted: number;
  rejected: number;
  rejectedByReason: Record<InventoryRejectionCode, number>;
  distinctIdentities: number;
}

const REPO_ROOT = resolve(__dirname, '../../../..');
const TSX_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const GENERATOR = join(REPO_ROOT, 'scripts', 'generate-dataset.ts');
const SAMPLE_CSV = join(REPO_ROOT, 'data', 'sample-inventory.csv');
const SAMPLE_MANIFEST = join(REPO_ROOT, 'data', 'sample-inventory.manifest.json');

function readManifest(path: string): DatasetManifest {
  const parsed: DatasetManifest = JSON.parse(readFileSync(path, 'utf8'));
  return parsed;
}

function zeroReasons(): Record<InventoryRejectionCode, number> {
  return {
    COLUMN_COUNT: 0,
    MALFORMED_ROW: 0,
    MISSING_FIELD: 0,
    INVALID_MONEY: 0,
    INVALID_QUANTITY: 0,
    INVALID_COUNTRY: 0,
    INVALID_DATE: 0,
    INVALID_CHARACTER: 0,
    INVALID_LENGTH: 0,
  };
}

function reconcile(content: Buffer): ReconciledCounts {
  const rejectedByReason = zeroReasons();
  const records: string[][] = parse(content, {
    delimiter: INVENTORY_CSV_DELIMITER,
    record_delimiter: ['\r\n', '\n'],
    relax_quotes: false,
    relax_column_count: true,
    skip_records_with_error: true,
    on_skip: () => {
      rejectedByReason.MALFORMED_ROW += 1;
      return undefined;
    },
  });
  const [header = [], ...rows] = records;

  const identities = new Set<string>();
  let accepted = 0;
  for (const cells of rows) {
    if (cells.length !== INVENTORY_CSV_COLUMNS.length) {
      rejectedByReason.COLUMN_COUNT += 1;
      continue;
    }
    const result = classifyInventoryCells(cells);
    if (result.ok) {
      accepted += 1;
      identities.add(inventoryIdentityKey(result.row));
    } else {
      rejectedByReason[result.code] += 1;
    }
  }
  const rejected = Object.values(rejectedByReason).reduce((sum, count) => sum + count, 0);
  return {
    headerValid: isInventoryCsvHeader(header),
    total: rows.length + rejectedByReason.MALFORMED_ROW, accepted, rejected, rejectedByReason, distinctIdentities: identities.size,
  };
}

describe('generate-dataset', () => {
  let workDir = '';

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'stockpile-dataset-'));
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function generate(name: string, seed: number): { csv: Buffer; manifest: Buffer } {
    const out = join(workDir, `${name}.csv`);
    execFileSync(TSX_BIN, [GENERATOR, '--rows', '300', '--seed', String(seed), '--out', out], { cwd: REPO_ROOT, stdio: 'pipe' });
    return { csv: readFileSync(out), manifest: readFileSync(join(workDir, `${name}.manifest.json`)) };
  }

  it('produces byte identical CSV and manifest for the same seed and different CSV for another seed', () => {
    const first = generate('first', 42);
    const second = generate('second', 42);
    const other = generate('other', 43);

    expect(Buffer.compare(first.csv, second.csv)).toBe(0);
    expect(Buffer.compare(first.manifest, second.manifest)).toBe(0);
    expect(Buffer.compare(first.csv, other.csv)).not.toBe(0);
  }, 60_000);

  it('labels a generated file with counts that an independent parser reproduces', () => {
    const { csv } = generate('labelled', 7);
    const manifest = readManifest(join(workDir, 'labelled.manifest.json'));
    const counts = reconcile(csv);

    expect(counts).toEqual({
      headerValid: true,
      total: manifest.total,
      accepted: manifest.accepted,
      rejected: manifest.rejected,
      rejectedByReason: manifest.rejectedByReason,
      distinctIdentities: manifest.expectedCreated,
    });
    expect(manifest.expectedCreated + manifest.expectedUpdated).toBe(manifest.accepted);
  }, 60_000);
});

describe('committed sample dataset', () => {
  const manifest = readManifest(SAMPLE_MANIFEST);
  const counts = reconcile(readFileSync(SAMPLE_CSV));

  it('matches the manifest totals counted by an independent RFC 4180 parser', () => {
    expect(counts.headerValid).toBe(true);
    expect(counts.total).toBe(manifest.total);
    expect(counts.total).toBe(manifest.rows);
    expect(counts.accepted + counts.rejected).toBe(counts.total);
    expect(counts.accepted).toBe(manifest.accepted);
    expect(counts.rejected).toBe(manifest.rejected);
  });

  it('matches the manifest rejection breakdown and covers every rejection code', () => {
    expect(counts.rejectedByReason).toEqual(manifest.rejectedByReason);
    for (const code of INVENTORY_REJECTION_CODES) {
      expect(counts.rejectedByReason[code], code).toBeGreaterThanOrEqual(1);
    }
  });

  it('matches the expected created and updated identities', () => {
    expect(counts.distinctIdentities).toBe(manifest.expectedCreated);
    expect(manifest.expectedCreated + manifest.expectedUpdated).toBe(manifest.accepted);
  });
});
