import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ZodSerializerInterceptor, ZodValidationPipe } from 'nestjs-zod';
import { AppConfigModule } from './infra/config/config.module';
import { ListingModule } from './infra/listing/listing.module';
import { LoggerModule } from './infra/logger/logger.module';
import { PrismaModule } from './infra/prisma/prisma.module';
import { QueueModule } from './infra/queue/queue.module';
import { RedisModule } from './infra/redis/redis.module';
import { AuthModule } from './modules/auth/auth.module';
import { ExchangeRatesModule } from './modules/exchange-rates/exchange-rates.module';
import { HealthModule } from './modules/health/health.module';
import { ImportsModule } from './modules/imports/imports.module';
import { RolesModule } from './modules/roles/roles.module';
import { StockItemsModule } from './modules/stock-items/stock-items.module';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule,
    PrismaModule,
    ListingModule,
    RedisModule,
    QueueModule,
    AuthModule,
    ExchangeRatesModule,
    HealthModule,
    ImportsModule,
    RolesModule,
    StockItemsModule,
    UsersModule,
  ],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor },
  ],
})
export class AppModule { }
