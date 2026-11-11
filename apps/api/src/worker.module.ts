import { Module } from '@nestjs/common';
import { AppConfigModule } from './infra/config/config.module';
import { LoggerModule } from './infra/logger/logger.module';
import { PrismaModule } from './infra/prisma/prisma.module';
import { QueueModule } from './infra/queue/queue.module';
import { RedisModule } from './infra/redis/redis.module';
import { ImportsWorkerModule } from './modules/imports/imports-worker.module';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule,
    PrismaModule,
    RedisModule,
    QueueModule,
    ImportsWorkerModule,
  ],
})
export class WorkerModule { }
