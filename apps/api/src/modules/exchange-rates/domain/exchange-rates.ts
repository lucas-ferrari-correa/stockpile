import Big from 'big.js';

export interface RateSnapshot {
  importId: string;
  base: string;
  rateDate: string;
  fetchedAt: Date;
  source: string;
  rates: Record<string, number>;
}

function parseRate(rate: number | string): Big {
  let parsed: Big;
  try {
    parsed = new Big(rate);
  } catch {
    throw new RangeError(`Invalid exchange rate: ${String(rate)}`);
  }
  if (parsed.lte(0)) {
    throw new RangeError(`Invalid exchange rate: ${String(rate)}`);
  }
  return parsed;
}

export function convertCents(priceCents: number, rate: number | string): number {
  if (!Number.isSafeInteger(priceCents) || priceCents < 0) {
    throw new RangeError(`Invalid price in cents: ${priceCents}`);
  }
  const converted = parseRate(rate).times(priceCents).round(0, Big.roundHalfUp);
  if (converted.gt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`Converted price exceeds the safe integer range: ${converted.toFixed()}`);
  }
  return converted.toNumber();
}

export function missingCurrencies(required: readonly string[], rates: Record<string, number>): string[] {
  return required.filter((currency) => !Object.hasOwn(rates, currency));
}
