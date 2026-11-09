import { z } from 'zod';
import { ExchangeRatesProvider, ExchangeRatesUnavailableError, LatestRates } from '../ports/exchange-rates.provider';

export const FAWAZ_DEFAULT_BASE_URLS: readonly string[] = [
  'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1',
  'https://latest.currency-api.pages.dev/v1',
];

export const FAWAZ_DEFAULT_TIMEOUT_MS = 2000;
export const FAWAZ_DEFAULT_ATTEMPTS_PER_HOST = 2;

export interface FawazExchangeRatesProviderOptions {
  baseUrls?: readonly string[];
  timeoutMs?: number;
  attemptsPerHost?: number;
}

const responseSchema = z.object({
  date: z.iso.date(),
});

const ratesSchema = z.record(z.string(), z.number());

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class FawazExchangeRatesProvider implements ExchangeRatesProvider {
  private readonly baseUrls: readonly string[];
  private readonly timeoutMs: number;
  private readonly attemptsPerHost: number;

  constructor(options: FawazExchangeRatesProviderOptions = {}) {
    this.baseUrls = options.baseUrls ?? FAWAZ_DEFAULT_BASE_URLS;
    this.timeoutMs = options.timeoutMs ?? FAWAZ_DEFAULT_TIMEOUT_MS;
    this.attemptsPerHost = options.attemptsPerHost ?? FAWAZ_DEFAULT_ATTEMPTS_PER_HOST;
  }

  async fetchLatest(base: string): Promise<LatestRates> {
    const key = base.toLowerCase();
    const failures: string[] = [];

    for (const baseUrl of this.baseUrls) {
      const url = `${baseUrl}/currencies/${key}.min.json`;

      for (let attempt = 1; attempt <= this.attemptsPerHost; attempt++) {
        try {
          return await this.request(url, key);
        } catch (error) {
          failures.push(`${url} (attempt ${attempt}): ${errorMessage(error)}`);
        }
      }
    }
    throw new ExchangeRatesUnavailableError(base.toUpperCase(), failures);
  }

  private async request(url: string, key: string): Promise<LatestRates> {
    const response = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const body: unknown = await response.json();
    const parsed = responseSchema.parse(body);
    const rawRates: unknown = typeof body === 'object' && body !== null ? Reflect.get(body, key) : undefined;
    const rates = ratesSchema.parse(rawRates);
    const normalized: Record<string, number> = {};

    for (const [currency, value] of Object.entries(rates)) {
      if (Number.isFinite(value) && value > 0) {
        normalized[currency.toUpperCase()] = value;
      }
    }
    return {
      date: parsed.date,
      rates: normalized,
      source: new URL(url).host
    };
  }
}
