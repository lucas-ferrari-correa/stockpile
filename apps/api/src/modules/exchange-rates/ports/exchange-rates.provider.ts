export interface LatestRates {
  date: string;
  rates: Record<string, number>;
  source: string;
}

export interface ExchangeRatesProvider {
  fetchLatest(base: string): Promise<LatestRates>;
}

export const EXCHANGE_RATES_PROVIDER = Symbol('EXCHANGE_RATES_PROVIDER');

export class ExchangeRatesUnavailableError extends Error {
  readonly code = 'RATES_UNAVAILABLE';

  constructor(
    readonly base: string,
    readonly attempts: readonly string[],
  ) {
    super(`Exchange rates for ${base} are unavailable: ${attempts.join('; ')}`);
    this.name = 'ExchangeRatesUnavailableError';
  }
}
