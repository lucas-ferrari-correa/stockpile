import { Inject, Injectable } from '@nestjs/common';
import { ImportStatus } from '@stockpile/shared';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '../../../infra/config/app-config.service';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { FILE_STORAGE, FileStorage } from '../ports/file-storage';
import { IMPORT_QUEUE, ImportQueue } from '../ports/import-queue';
import { IMPORT_FILE_MISSING_REASON, IMPORT_INTERRUPTED_REASON } from './imports.errors';

export const RECONCILE_BATCH_SIZE = 100;

export type ImportRecoveryAction = 'interrupted' | 'file-missing' | 'requeued' | 'queued' | 'skipped';

export interface ImportRecoverySummary {
  interrupted: number;
  fileMissing: number;
  requeued: number;
}

interface StaleImport {
  id: string;
  status: ImportStatus;
  filePath: string | null;
  rateSnapshot: { id: string } | null;
}

@Injectable()
export class ImportRecoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    @Inject(IMPORT_QUEUE) private readonly queue: ImportQueue,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ImportRecoveryService.name);
  }

  async reconcile(now: Date = new Date()): Promise<ImportRecoverySummary> {
    const cutoff = new Date(now.getTime() - this.config.get('IMPORT_RECONCILE_AFTER_MS'));
    const stale: StaleImport[] = await this.prisma.import.findMany({
      where: { status: { in: ['pending', 'processing'] }, updatedAt: { lt: cutoff } },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: RECONCILE_BATCH_SIZE,
      select: { id: true, status: true, filePath: true, rateSnapshot: { select: { id: true } } },
    });

    const summary: ImportRecoverySummary = { interrupted: 0, fileMissing: 0, requeued: 0 };
    for (const row of stale) {
      let action: ImportRecoveryAction;
      try {
        action = await this.recover(row, cutoff);
      } catch (error) {
        this.logger.error({ importId: row.id, err: error }, 'Import recovery failed');
        continue;
      }

      if (action === 'interrupted') {
        summary.interrupted += 1;
      } else if (action === 'file-missing') {
        summary.fileMissing += 1;
      } else if (action === 'requeued') {
        summary.requeued += 1;
      }
    }

    return summary;
  }

  private async recover(row: StaleImport, cutoff: Date): Promise<ImportRecoveryAction> {
    if (row.status === 'pending' && row.rateSnapshot === null) {
      return (await this.fail(row, cutoff, IMPORT_INTERRUPTED_REASON)) ? 'interrupted' : 'skipped';
    }

    if (await this.queue.isQueued(row.id)) {
      return 'queued';
    }

    if (row.filePath === null || !(await this.storage.exists(row.filePath))) {
      return (await this.fail(row, cutoff, IMPORT_FILE_MISSING_REASON)) ? 'file-missing' : 'skipped';
    }

    await this.queue.enqueue({ importId: row.id, filePath: row.filePath });
    this.logger.info({ importId: row.id, status: row.status }, 'Import requeued by reconciliation');

    return 'requeued';
  }

  private async fail(row: StaleImport, cutoff: Date, reason: string): Promise<boolean> {
    const { count } = await this.prisma.import.updateMany({
      where: { id: row.id, status: row.status, updatedAt: { lt: cutoff } },
      data: { status: 'failed', failureReason: reason },
    });

    if (count === 0) {
      return false;
    }

    if (row.filePath !== null) {
      await this.storage.remove(row.filePath);
    }
    this.logger.warn({ importId: row.id, previousStatus: row.status, failureReason: reason }, 'Import failed by reconciliation');

    return true;
  }
}
