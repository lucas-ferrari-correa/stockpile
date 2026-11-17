import { ClassProvider, Injectable } from '@nestjs/common';
import { NUL_CHARACTER } from '@stockpile/shared';
import { z } from 'zod';
import { toDbDate } from '../../../../infra/dates/calendar-date';
import { PrismaService } from '../../../../infra/prisma/prisma.service';
import {
  CatalogMergeResult,
  IMPORT_CATALOG_REPOSITORY,
  ImportCatalogRepository,
  ImportNotProcessingError,
  ImportRunSummary,
  ImportStagingBatch,
} from '../../ports/import-catalog';

const STORABLE_NUL_REPLACEMENT = '�';

const CATALOG_MERGE_LOCK_NAME = 'stock_items_catalog_merge';

const CATALOG_MERGE_TIMEOUT_MS = 600_000;

const CATALOG_MERGE_MAX_WAIT_MS = 60_000;

const mergeCountsSchema = z.object({
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
});

function toStorableText(text: string): string {
  return text.replaceAll(NUL_CHARACTER, STORABLE_NUL_REPLACEMENT);
}

@Injectable()
export class PrismaImportCatalogRepository implements ImportCatalogRepository {
  constructor(private readonly prisma: PrismaService) {}

  async startRun(importId: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const started = await tx.import.updateMany({
        where: { id: importId, status: { in: ['pending', 'processing'] } },
        data: {
          status: 'processing',
          totalRows: null,
          processedRows: 0,
          acceptedRows: 0,
          rejectedRows: 0,
          rejectedByReason: {},
          itemsCreated: 0,
          itemsUpdated: 0,
          failureReason: null,
        },
      });

      if (started.count === 0) {
        return false;
      }

      await tx.importError.deleteMany({ where: { importId } });
      await tx.importStagedRow.deleteMany({ where: { importId } });
      return true;
    });
  }

  async stageBatch(importId: string, batch: ImportStagingBatch): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.importStagedRow.createMany({
        data: batch.rows.map(({ line, row }) => ({
          importId,
          line,
          sku: row.sku,
          name: row.name,
          category: row.category,
          brand: row.brand,
          supplier: row.supplier,
          country: row.country,
          warehouse: row.warehouse,
          lot: row.lot,
          quantity: row.quantity,
          unitCostCents: row.unit_cost,
          unitPriceCents: row.unit_price,
          expiration: row.expiration === null ? null : toDbDate(row.expiration),
        })),
      }),
      this.prisma.importError.createMany({
        data: batch.rejections.map((rejection) => ({
          importId,
          line: rejection.line,
          field: rejection.field,
          code: rejection.code,
          message: toStorableText(rejection.message),
          raw: toStorableText(rejection.raw),
        })),
      }),
      this.prisma.import.update({
        where: { id: importId },
        data: batch.progress,
        select: { id: true },
      }),
    ]);
  }

  async mergeIntoCatalog(importId: string, summary: ImportRunSummary): Promise<CatalogMergeResult> {
    return this.prisma.$transaction(
      async (tx) => {
        const completed = await tx.import.updateMany({
          where: { id: importId, status: 'processing' },
          data: {
            status: 'completed',
            totalRows: summary.totalRows,
            processedRows: summary.totalRows,
            acceptedRows: summary.acceptedRows,
            rejectedRows: summary.rejectedRows,
            rejectedByReason: summary.rejectedByReason,
          },
        });

        if (completed.count === 0) {
          throw new ImportNotProcessingError(importId);
        }

        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${CATALOG_MERGE_LOCK_NAME}))`;

        await tx.$executeRaw`
          UPDATE imports
          SET item_count = imports.item_count - lost.total, updated_at = now()
          FROM (
            SELECT items.import_id, count(*)::int AS total
            FROM stock_items AS items
            WHERE items.import_id <> ${importId}::uuid
              AND EXISTS (
                SELECT 1
                FROM import_staged_rows AS staged
                WHERE staged.import_id = ${importId}::uuid
                  AND staged.sku = items.sku
                  AND staged.warehouse = items.warehouse
                  AND staged.lot = items.lot
              )
            GROUP BY items.import_id
          ) AS lost
          WHERE imports.id = lost.import_id
        `;

        const rows = await tx.$queryRaw<unknown[]>`
          WITH merged AS (
            INSERT INTO stock_items (
              import_id, sku, name, category, brand, supplier, country, warehouse, lot,
              quantity, unit_cost_cents, unit_price_cents, expiration
            )
            SELECT DISTINCT ON (staged.sku, staged.warehouse, staged.lot)
              staged.import_id, staged.sku, staged.name, staged.category, staged.brand, staged.supplier,
              staged.country, staged.warehouse, staged.lot, staged.quantity, staged.unit_cost_cents,
              staged.unit_price_cents, staged.expiration
            FROM import_staged_rows AS staged
            WHERE staged.import_id = ${importId}::uuid
            ORDER BY staged.sku, staged.warehouse, staged.lot, staged.line DESC
            ON CONFLICT (sku, warehouse, lot) DO UPDATE
            SET import_id = EXCLUDED.import_id,
              name = EXCLUDED.name,
              category = EXCLUDED.category,
              brand = EXCLUDED.brand,
              supplier = EXCLUDED.supplier,
              country = EXCLUDED.country,
              quantity = EXCLUDED.quantity,
              unit_cost_cents = EXCLUDED.unit_cost_cents,
              unit_price_cents = EXCLUDED.unit_price_cents,
              expiration = EXCLUDED.expiration
            RETURNING (xmax = 0) AS inserted
          )
          SELECT
            (count(*) FILTER (WHERE inserted))::int AS created,
            (count(*) FILTER (WHERE NOT inserted))::int AS updated
          FROM merged
        `;
        const counts = mergeCountsSchema.parse(rows[0]);

        await tx.import.update({
          where: { id: importId },
          data: {
            itemCount: counts.created + counts.updated,
            itemsCreated: counts.created,
            itemsUpdated: counts.updated,
          },
          select: { id: true },
        });
        await tx.importStagedRow.deleteMany({ where: { importId } });

        return { itemsCreated: counts.created, itemsUpdated: counts.updated };
      },
      { timeout: CATALOG_MERGE_TIMEOUT_MS, maxWait: CATALOG_MERGE_MAX_WAIT_MS },
    );
  }

  async clearStaging(importId: string): Promise<void> {
    await this.prisma.importStagedRow.deleteMany({ where: { importId } });
  }

  async analyzeCatalog(): Promise<void> {
    await this.prisma.$executeRaw`VACUUM (ANALYZE) stock_items`;
  }
}

export const importCatalogRepositoryProvider: ClassProvider<ImportCatalogRepository> = {
  provide: IMPORT_CATALOG_REPOSITORY,
  useClass: PrismaImportCatalogRepository,
};
