import { Module } from '@nestjs/common';
import { ImportProcessor } from './adapters/queue/import.processor';
import { ImportReconcileScheduler } from './adapters/schedule/import-reconcile.scheduler';
import { fileStorageProvider } from './adapters/storage/local-file-storage';
import { ImportProcessingService } from './application/import-processing.service';
import { ImportRecoveryService } from './application/import-recovery.service';
import { ImportQueueModule } from './import-queue.module';

@Module({
  imports: [ImportQueueModule],
  providers: [ImportProcessor, ImportProcessingService, ImportRecoveryService, ImportReconcileScheduler, fileStorageProvider],
})
export class ImportsWorkerModule {}
