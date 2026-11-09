import { Module } from '@nestjs/common';
import type Redis from 'ioredis';
import { AppConfigService } from '../../infra/config/app-config.service';
import { REDIS } from '../../infra/redis/redis.constants';
import { FawazExchangeRatesProvider } from './adapters/fawaz-exchange-rates.provider';
import { RedisCachedExchangeRatesProvider } from './adapters/redis-cached-exchange-rates.provider';
import { ExchangeRatesService } from './application/exchange-rates.service';
import { EXCHANGE_RATES_PROVIDER, ExchangeRatesProvider } from './ports/exchange-rates.provider';

@Module({
  providers: [
    {
      provide: EXCHANGE_RATES_PROVIDER,
      inject: [REDIS, AppConfigService],
      useFactory: (redis: Redis, config: AppConfigService): ExchangeRatesProvider =>
        new RedisCachedExchangeRatesProvider(
          new FawazExchangeRatesProvider({ timeoutMs: config.get('EXCHANGE_RATES_TIMEOUT_MS') }),
          redis,
        ),
    },
    ExchangeRatesService,
  ],
  exports: [ExchangeRatesService],
})
export class ExchangeRatesModule {}
