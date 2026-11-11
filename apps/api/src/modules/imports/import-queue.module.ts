import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { BullMqImportQueue } from './adapters/queue/bullmq-import-queue';
import { IMPORTS_QUEUE } from './adapters/queue/imports-queue.constants';
import { IMPORT_QUEUE } from './ports/import-queue';

@Module({
  imports: [BullModule.registerQueue({ name: IMPORTS_QUEUE })],
  providers: [{ provide: IMPORT_QUEUE, useClass: BullMqImportQueue }],
  exports: [IMPORT_QUEUE, BullModule],
})
export class ImportQueueModule {}
