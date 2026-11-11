import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { JobState, Queue } from 'bullmq';
import { AppConfigService } from '../../../../infra/config/app-config.service';
import { ImportJobPayload, ImportQueue } from '../../ports/import-queue';
import {
  IMPORTS_QUEUE,
  IMPORT_JOBS_KEPT_ON_COMPLETE,
  IMPORT_JOBS_KEPT_ON_FAIL,
  IMPORT_JOB_NAME,
} from './imports-queue.constants';

const QUEUED_STATES: ReadonlySet<JobState | 'unknown'> = new Set<JobState>(['active', 'waiting', 'waiting-children', 'delayed', 'prioritized']);

const FINISHED_STATES: ReadonlySet<JobState | 'unknown'> = new Set<JobState>(['completed', 'failed']);

@Injectable()
export class BullMqImportQueue implements ImportQueue {
  constructor(
    @InjectQueue(IMPORTS_QUEUE) private readonly queue: Queue<ImportJobPayload>,
    private readonly config: AppConfigService,
  ) {}

  async enqueue(payload: ImportJobPayload): Promise<void> {
    const existing = await this.queue.getJob(payload.importId);
    if (existing && FINISHED_STATES.has(await existing.getState())) {
      await existing.remove();
    }

    await this.queue.add(IMPORT_JOB_NAME, payload, {
      jobId: payload.importId,
      attempts: this.config.get('IMPORT_JOB_ATTEMPTS'),
      backoff: { type: 'exponential', delay: this.config.get('IMPORT_JOB_BACKOFF_MS') },
      removeOnComplete: { count: IMPORT_JOBS_KEPT_ON_COMPLETE },
      removeOnFail: { count: IMPORT_JOBS_KEPT_ON_FAIL },
    });
  }

  async isQueued(importId: string): Promise<boolean> {
    const job = await this.queue.getJob(importId);
    if (!job) {
      return false;
    }

    const state = await job.getState();
    return QUEUED_STATES.has(state);
  }

  async isReady(): Promise<boolean> {
    try {
      await this.queue.getJobCounts('wait');
      return true;
    } catch {
      return false;
    }
  }
}
