import { Module } from '@nestjs/common';
import { ImportQueueModule } from '../imports/import-queue.module';
import { HealthController } from './adapters/http/health.controller';
import { HealthService } from './application/health.service';

@Module({
  imports: [ImportQueueModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
