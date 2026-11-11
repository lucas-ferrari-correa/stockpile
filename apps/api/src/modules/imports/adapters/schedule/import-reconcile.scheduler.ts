import { Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '../../../../infra/config/app-config.service';
import { ImportRecoveryService } from '../../application/import-recovery.service';

@Injectable()
export class ImportReconcileScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;

  constructor(
    private readonly recovery: ImportRecoveryService,
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ImportReconcileScheduler.name);
  }

  onApplicationBootstrap(): void {
    const intervalMs = this.config.get('IMPORT_RECONCILE_INTERVAL_MS');
    this.tick();
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.logger.info({ intervalMs, afterMs: this.config.get('IMPORT_RECONCILE_AFTER_MS') }, 'Import reconciliation scheduled');
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.running;
  }

  private tick(): void {
    if (this.running !== undefined) {
      return;
    }

    this.running = this.recovery
      .reconcile()
      .then((summary) => {
        if (summary.interrupted + summary.fileMissing + summary.requeued > 0) {
          this.logger.info(summary, 'Import reconciliation finished');
        }
      })
      .catch((error: unknown) => {
        this.logger.error({ err: error }, 'Import reconciliation run failed');
      })
      .finally(() => {
        this.running = undefined;
      });
  }
}
