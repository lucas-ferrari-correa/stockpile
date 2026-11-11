import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { OnApplicationBootstrap } from '@nestjs/common';
import { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '../../../../infra/config/app-config.service';
import { ImportProcessingService } from '../../application/import-processing.service';
import { importJobPayloadSchema } from '../../ports/import-queue';
import { IMPORTS_QUEUE } from './imports-queue.constants';

function isFinalFailure(job: Job): boolean {
  return typeof job.finishedOn === 'number' || job.attemptsMade >= (job.opts.attempts ?? 1);
}

@Processor(IMPORTS_QUEUE, { autorun: false })
export class ImportProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly processing: ImportProcessingService,
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    super();
    this.logger.setContext(ImportProcessor.name);
  }

  onApplicationBootstrap(): void {
    const concurrency = this.config.get('IMPORT_CONCURRENCY');

    this.worker.concurrency = concurrency;
    this.worker.run().catch((error: unknown) => {
      this.logger.error({ err: error }, 'Import worker stopped unexpectedly');
    });

    this.logger.info({ queue: IMPORTS_QUEUE, concurrency }, 'Import worker running');
  }

  async process(job: Job): Promise<void> {
    const payload = importJobPayloadSchema.parse(job.data);
    this.logger.info({ importId: payload.importId, attempt: job.attemptsMade + 1 }, 'Import job started');

    await this.processing.run(payload);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined, error: Error): Promise<void> {
    if (!job) {
      this.logger.error({ err: error }, 'Import job failed and was removed');
      return;
    }

    const final = isFinalFailure(job);
    this.logger.error(
      { importId: job.id, attemptsMade: job.attemptsMade, final, err: error },
      final ? 'Import job failed permanently' : 'Import job attempt failed',
    );

    if (!final) {
      return;
    }

    const payload = importJobPayloadSchema.safeParse(job.data);
    if (!payload.success) {
      return;
    }

    try {
      await this.processing.markFailed(payload.data, error);
    } catch (markError) {
      this.logger.error({ importId: payload.data.importId, err: markError }, 'Import could not be marked as failed');
    }
  }

  @OnWorkerEvent('stalled')
  onStalled(jobId: string): void {
    this.logger.warn({ importId: jobId }, 'Import job stalled');
  }
}
