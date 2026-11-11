import { createInterface } from 'node:readline';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { FILE_STORAGE, FileStorage } from '../ports/file-storage';
import { ImportJobPayload } from '../ports/import-queue';
import { failureReason } from './imports.errors';

export const PROGRESS_UPDATE_EVERY_ROWS = 500;

@Injectable()
export class ImportProcessingService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ImportProcessingService.name);
  }

  async run({ importId, filePath }: ImportJobPayload): Promise<void> {
    const current = await this.prisma.import.findUnique({ where: { id: importId }, select: { status: true } });

    if (!current) {
      this.logger.warn({ importId }, 'Import not found, skipping job');
      return;
    }

    if (current.status === 'completed' || current.status === 'failed') {
      this.logger.info({ importId, status: current.status }, 'Import already finished, skipping job');
      await this.storage.remove(filePath);
      return;
    }

    await this.prisma.import.update({
      where: { id: importId },
      data: {
        status: 'processing',
        totalRows: null,
        processedRows: 0,
        acceptedRows: 0,
        rejectedRows: 0,
        failureReason: null,
      },
      select: { id: true },
    });

    this.logger.info({ importId }, 'Import processing started');
    const processedRows = await this.countDataRows(importId, filePath);

    await this.prisma.import.update({
      where: { id: importId },
      data: {
        status: 'completed',
        processedRows,
        totalRows: processedRows,
      },
      select: { id: true },
    });

    await this.storage.remove(filePath);
    this.logger.info({ importId, totalRows: processedRows }, 'Import completed');
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

    await this.storage.remove(filePath);
    this.logger.error({ importId, failureReason: reason }, 'Import failed');
  }

  private async countDataRows(importId: string, filePath: string): Promise<number> {
    const lines = createInterface({ input: await this.storage.open(filePath), crlfDelay: Infinity });
    let isHeader = true;
    let processedRows = 0;

    for await (const line of lines) {
      if (isHeader) {
        isHeader = false;
        continue;
      }

      if (line.trim().length === 0) {
        continue;
      }

      processedRows += 1;
      if (processedRows % PROGRESS_UPDATE_EVERY_ROWS === 0) {
        await this.prisma.import.update({ where: { id: importId }, data: { processedRows }, select: { id: true } });
      }
    }

    return processedRows;
  }
}
