import { Inject, Injectable } from '@nestjs/common';
import { RejectedByReason } from '@stockpile/shared';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '../../../infra/config/app-config.service';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { parseInventoryCsv } from '../domain/inventory-csv-parser';
import { FILE_STORAGE, FileStorage } from '../ports/file-storage';
import {
  IMPORT_CATALOG_REPOSITORY,
  ImportCatalogRepository,
  ImportProgress,
  ImportRowRejection,
  ImportRunSummary,
  StagedInventoryRow,
} from '../ports/import-catalog';
import { ImportJobPayload } from '../ports/import-queue';
import { failureReason } from './imports.errors';

@Injectable()
export class ImportProcessingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    @Inject(IMPORT_CATALOG_REPOSITORY) private readonly catalog: ImportCatalogRepository,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ImportProcessingService.name);
  }

  async run({ importId, filePath }: ImportJobPayload): Promise<void> {
    const started = await this.catalog.startRun(importId);

    if (!started) {
      this.logger.info({ importId }, 'Import missing or already finished, skipping job');
      await this.storage.remove(filePath);
      return;
    }

    this.logger.info({ importId }, 'Import processing started');
    const summary = await this.stageFile(importId, filePath);
    const merge = await this.catalog.mergeIntoCatalog(importId, summary);

    try {
      await this.catalog.analyzeCatalog();
    } catch (error) {
      this.logger.warn({ importId, err: error }, 'Catalog statistics could not be refreshed');
    }

    await this.storage.remove(filePath);
    this.logger.info({ importId, ...summary, ...merge }, 'Import completed');
  }

  async markFailed({ importId, filePath }: ImportJobPayload, error: unknown): Promise<void> {
    const reason = failureReason(error);

    await this.prisma.import.updateMany({
      where: {
        id: importId,
        status: { not: 'completed' },
      },
      data: { status: 'failed', failureReason: reason },
    });

    await this.catalog.clearStaging(importId);
    await this.storage.remove(filePath);
    this.logger.error({ importId, failureReason: reason }, 'Import failed');
  }

  private async stageFile(importId: string, filePath: string): Promise<ImportRunSummary> {
    const batchSize = this.config.get('IMPORT_BATCH_SIZE');
    const rejectedByReason: RejectedByReason = {};
    const progress: ImportProgress = { processedRows: 0, acceptedRows: 0, rejectedRows: 0 };
    let rows: StagedInventoryRow[] = [];
    let rejections: ImportRowRejection[] = [];

    const flush = async (): Promise<void> => {
      await this.catalog.stageBatch(importId, { rows, rejections, progress: { ...progress } });
      rows = [];
      rejections = [];
    };

    for await (const parsed of parseInventoryCsv(await this.storage.open(filePath))) {
      progress.processedRows += 1;

      if (parsed.ok) {
        progress.acceptedRows += 1;
        rows.push({ line: parsed.line, row: parsed.row });
      } else {
        progress.rejectedRows += 1;
        rejectedByReason[parsed.code] = (rejectedByReason[parsed.code] ?? 0) + 1;
        rejections.push({ line: parsed.line, field: parsed.field, code: parsed.code, message: parsed.message, raw: parsed.raw });
      }

      if (rows.length + rejections.length >= batchSize) {
        await flush();
      }
    }

    if (rows.length + rejections.length > 0) {
      await flush();
    }

    return {
      totalRows: progress.processedRows,
      acceptedRows: progress.acceptedRows,
      rejectedRows: progress.rejectedRows,
      rejectedByReason,
    };
  }
}
