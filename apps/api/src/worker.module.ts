import { Module } from '@nestjs/common';
import { AppConfigModule } from './infra/config/config.module';
import { LoggerModule } from './infra/logger/logger.module';
import { PrismaModule } from './infra/prisma/prisma.module';
import { RedisModule } from './infra/redis/redis.module';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule,
    PrismaModule,
    RedisModule
  ],
})
export class WorkerModule { }
