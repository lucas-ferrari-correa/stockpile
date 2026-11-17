import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { inventoryRejectionCodeSchema } from '@stockpile/shared';
import { z } from 'zod';
import { ImportsHarness, SeededUser } from '../support/imports-harness';

const DATA_DIR = resolve(__dirname, '../../../../data');
const SAMPLE_PATH = resolve(DATA_DIR, 'sample-inventory.csv');
const MANIFEST_PATH = resolve(DATA_DIR, 'sample-inventory.manifest.json');
const IMPORT_TIMEOUT_MS = 120000;

const manifestSchema = z.object({
  total: z.number().int().nonnegative(),
  accepted: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  rejectedByReason: z.record(inventoryRejectionCodeSchema, z.number().int().nonnegative()),
  distinctIdentities: z.number().int().nonnegative(),
  expectedCreated: z.number().int().nonnegative(),
  repeatedIdentityRows: z.number().int().nonnegative(),
});

describe('import verification of the generated data file', () => {
  let harness: ImportsHarness;
  let admin: SeededUser;

  beforeAll(async () => {
    harness = await ImportsHarness.start({ redisDb: 12, env: { IMPORT_BATCH_SIZE: '128', IMPORT_JOB_BACKOFF_MS: '20' } });
    await harness.reset();
    admin = await harness.loginAdmin();
  });

  afterAll(async () => {
    await harness.close();
  });

  it(
    'imports the data file with the counts its generator manifest declares',
    async () => {
      const manifest = manifestSchema.parse(JSON.parse(await readFile(MANIFEST_PATH, 'utf8')));
      const nonZeroReasons = Object.fromEntries(Object.entries(manifest.rejectedByReason).filter(([, count]) => count > 0));

      const importId = await harness.importFile(admin.token, { content: await readFile(SAMPLE_PATH), name: 'sample-inventory.csv' }, IMPORT_TIMEOUT_MS);

      const counters = await harness.prisma.import.findUniqueOrThrow({
        where: { id: importId },
        select: { totalRows: true, acceptedRows: true, rejectedRows: true, rejectedByReason: true, itemCount: true, itemsCreated: true, itemsUpdated: true },
      });
      const rejected = await harness.prisma.importError.findMany({ where: { importId }, orderBy: { line: 'asc' }, select: { line: true, code: true } });
      const accepted = await harness.prisma.stockItem.findMany({
        where: { importId },
        orderBy: [{ sku: 'asc' }, { warehouse: 'asc' }, { lot: 'asc' }],
        select: { sku: true, warehouse: true, lot: true },
      });
      const verdictPath = process.env.IMPORT_VERDICT_OUT;
      if (verdictPath) {
        await writeFile(verdictPath, JSON.stringify({ rejected, accepted }));
      }

      expect(counters).toEqual({
        totalRows: manifest.total,
        acceptedRows: manifest.accepted,
        rejectedRows: manifest.rejected,
        rejectedByReason: nonZeroReasons,
        itemCount: manifest.distinctIdentities,
        itemsCreated: manifest.expectedCreated,
        itemsUpdated: 0,
      });
      expect(manifest.accepted + manifest.rejected).toBe(manifest.total);
      expect(manifest.expectedCreated + manifest.repeatedIdentityRows).toBe(manifest.accepted);
      expect(rejected).toHaveLength(manifest.rejected);
      expect(accepted).toHaveLength(manifest.distinctIdentities);
      expect(await harness.prisma.stockItem.count()).toBe(manifest.distinctIdentities);
    },
    IMPORT_TIMEOUT_MS * 2,
  );
});
