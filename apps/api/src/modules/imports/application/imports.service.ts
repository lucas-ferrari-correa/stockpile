import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthUser, ImportAccepted, ImportDetail, ImportStatus, rejectedByReasonSchema } from '@stockpile/shared';
import { PinoLogger } from 'nestjs-pino';
import { fromDbDate } from '../../../infra/dates/calendar-date';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { ExchangeRatesService } from '../../exchange-rates/application/exchange-rates.service';
import { FILE_STORAGE, FileStorage } from '../ports/file-storage';
import { IMPORT_QUEUE, ImportQueue } from '../ports/import-queue';
import { duplicateImport, failureReason, importNotFound, ratesUnavailable } from './imports.errors';

export interface UploadedCsv {
  fileName: string;
  filePath: string;
  contentSha256: string;
}

export interface UploadOptions {
  force: boolean;
}

const BLOCKING_STATUSES: ImportStatus[] = ['pending', 'processing', 'completed'];

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

@Injectable()
export class ImportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly exchangeRates: ExchangeRatesService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    @Inject(IMPORT_QUEUE) private readonly queue: ImportQueue,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ImportsService.name);
  }

  async create(user: AuthUser, upload: UploadedCsv, options: UploadOptions): Promise<ImportAccepted> {
    if (!options.force) {
      await this.rejectDuplicate(upload);
    }

    let importId: string;

    try {
      const created = await this.prisma.import.create({
        data: {
          createdById: user.id,
          fileName: upload.fileName,
          contentSha256: upload.contentSha256,
          forced: options.force,
          filePath: upload.filePath,
        },
        select: { id: true },
      });

      importId = created.id;
    } catch (error) {
      await this.storage.remove(upload.filePath);
      if (isUniqueViolation(error)) {
        const existing = await this.findBlocking(upload.contentSha256);
        if (existing !== null) {
          this.logger.info({ existingImportId: existing.id, fileName: upload.fileName }, 'Duplicate import rejected');
          throw duplicateImport(existing.id);
        }
      }
      throw error;
    }
    this.logger.info({ importId, fileName: upload.fileName, userId: user.id, forced: options.force }, 'Import created');

    try {
      await this.exchangeRates.captureSnapshot(importId);
    } catch (error) {
      await this.fail(importId, upload.filePath, error, 'Exchange rate snapshot failed');
      throw ratesUnavailable(importId);
    }

    try {
      await this.queue.enqueue({
        importId,
        filePath: upload.filePath,
      });
    } catch (error) {
      this.logger.warn({ importId, err: error }, 'Import could not be enqueued, left pending for reconciliation');
      return { importId };
    }

    this.logger.info({ importId }, 'Import enqueued');

    return { importId };
  }

  async find(id: string): Promise<ImportDetail> {
    const found = await this.prisma.import.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        fileName: true,
        totalRows: true,
        processedRows: true,
        acceptedRows: true,
        rejectedRows: true,
        rejectedByReason: true,
        failureReason: true,
        createdAt: true,
        updatedAt: true,
        rateSnapshot: { select: { rateDate: true, base: true } },
      },
    });

    if (!found) {
      throw importNotFound();
    }

    return {
      id: found.id,
      status: found.status,
      fileName: found.fileName,
      totalRows: found.totalRows,
      processedRows: found.processedRows,
      acceptedRows: found.acceptedRows,
      rejectedRows: found.rejectedRows,
      rejectedByReason: rejectedByReasonSchema.parse(found.rejectedByReason),
      failureReason: found.failureReason,
      createdAt: found.createdAt.toISOString(),
      updatedAt: found.updatedAt.toISOString(),
      rates: found.rateSnapshot ? { date: fromDbDate(found.rateSnapshot.rateDate), base: found.rateSnapshot.base } : null,
    };
  }

  private findBlocking(contentSha256: string): Promise<{ id: string } | null> {
    return this.prisma.import.findFirst({
      where: { contentSha256, status: { in: BLOCKING_STATUSES } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
  }

  private async rejectDuplicate(upload: UploadedCsv): Promise<void> {
    let existing: { id: string } | null;
    try {
      existing = await this.findBlocking(upload.contentSha256);
    } catch (error) {
      await this.storage.remove(upload.filePath);
      throw error;
    }
    if (existing !== null) {
      await this.storage.remove(upload.filePath);
      this.logger.info({ existingImportId: existing.id, fileName: upload.fileName }, 'Duplicate import rejected');
      throw duplicateImport(existing.id);
    }
  }

  private async fail(importId: string, filePath: string, error: unknown, message: string): Promise<void> {
    const reason = failureReason(error);
    try {
      await this.prisma.import.update({
        where: { id: importId },
        data: { status: 'failed', failureReason: reason },
        select: { id: true },
      });
    } finally {
      await this.storage.remove(filePath);
    }
    this.logger.warn({ importId, err: error }, message);
  }
}
