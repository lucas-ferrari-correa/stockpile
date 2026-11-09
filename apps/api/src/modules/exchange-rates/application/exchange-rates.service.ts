import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BASE_CURRENCY } from '@stockpile/shared';
import { AppConfigService } from '../../../infra/config/app-config.service';
import { fromDbDate, toDbDate } from '../../../infra/dates/calendar-date';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { RateSnapshot, missingCurrencies } from '../domain/exchange-rates';
import { EXCHANGE_RATES_PROVIDER, ExchangeRatesProvider } from '../ports/exchange-rates.provider';
import { MissingCurrencyError, SnapshotAlreadyExistsError } from './exchange-rates.errors';

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

@Injectable()
export class ExchangeRatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    @Inject(EXCHANGE_RATES_PROVIDER) private readonly provider: ExchangeRatesProvider,
  ) { }

  async captureSnapshot(importId: string): Promise<RateSnapshot> {
    const existing = await this.prisma.exchangeRateSnapshot.findUnique({
      where: { importId },
      select: { id: true },
    });

    if (existing) {
      throw new SnapshotAlreadyExistsError(importId);
    }

    const latest = await this.provider.fetchLatest(BASE_CURRENCY);
    const currencies = this.config.get('EXCHANGE_CURRENCIES');
    const missing = missingCurrencies(currencies, latest.rates);

    if (missing.length > 0) {
      throw new MissingCurrencyError(missing);
    }

    const rates: Record<string, number> = {};
    for (const currency of currencies) {
      const rate = latest.rates[currency];
      if (rate !== undefined) {
        rates[currency] = rate;
      }
    }

    try {
      const created = await this.prisma.exchangeRateSnapshot.create({
        data: {
          importId,
          base: BASE_CURRENCY,
          rateDate: toDbDate(latest.date),
          fetchedAt: new Date(),
          source: latest.source,
          rates,
        },
        select: { importId: true, base: true, rateDate: true, fetchedAt: true, source: true },
      });
      return {
        importId: created.importId,
        base: created.base,
        rateDate: fromDbDate(created.rateDate),
        fetchedAt: created.fetchedAt,
        source: created.source,
        rates,
      };
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new SnapshotAlreadyExistsError(importId);
      }

      throw error;
    }
  }
}
