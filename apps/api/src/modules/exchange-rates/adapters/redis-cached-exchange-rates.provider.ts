import { Logger, LoggerService } from '@nestjs/common';
import type Redis from 'ioredis';
import { calendarDateSchema } from '@stockpile/shared';
import { z } from 'zod';
import { utcToday } from '../../../infra/dates/calendar-date';
import { ExchangeRatesProvider, LatestRates } from '../ports/exchange-rates.provider';

export const RATES_CACHE_TTL_SECONDS = 86400;

export interface RedisCachedExchangeRatesProviderOptions {
  ttlSeconds?: number;
  now?: () => Date;
  logger?: LoggerService;
}

const cachedRatesSchema = z.object({
  date: calendarDateSchema,
  rates: z.record(z.string(), z.number()),
  source: z.string(),
});

export function ratesCacheKey(base: string, now: Date): string {
  return `rates:${base.toLowerCase()}:${utcToday(now)}`;
}

export class RedisCachedExchangeRatesProvider implements ExchangeRatesProvider {
  private readonly ttlSeconds: number;
  private readonly now: () => Date;
  private readonly logger: LoggerService;

  constructor(
    private readonly inner: ExchangeRatesProvider,
    private readonly redis: Redis,
    options: RedisCachedExchangeRatesProviderOptions = {},
  ) {
    this.ttlSeconds = options.ttlSeconds ?? RATES_CACHE_TTL_SECONDS;
    this.now = options.now ?? ((): Date => new Date());
    this.logger = options.logger ?? new Logger(RedisCachedExchangeRatesProvider.name);
  }

  async fetchLatest(base: string): Promise<LatestRates> {
    const key = ratesCacheKey(base, this.now());
    const cached = await this.readCache(key);

    if (cached !== null) {
      const parsed = this.parseCached(cached);

      if (parsed) {
        return parsed;
      }
    }

    const fresh = await this.inner.fetchLatest(base);
    await this.writeCache(key, fresh);

    return fresh;
  }

  private async readCache(key: string): Promise<string | null> {
    try {
      return await this.redis.get(key);
    } catch (error) {
      this.logger.warn({ key, err: error }, 'Exchange rates cache read failed');
      return null;
    }
  }

  private async writeCache(key: string, rates: LatestRates): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(rates), 'EX', this.ttlSeconds);
    } catch (error) {
      this.logger.warn({ key, err: error }, 'Exchange rates cache write failed');
    }
  }

  private parseCached(raw: string): LatestRates | null {
    try {
      const value: unknown = JSON.parse(raw);
      const result = cachedRatesSchema.safeParse(value);

      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }
}
