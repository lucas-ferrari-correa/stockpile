import { describe, expect, it } from 'vitest';
import { currencyListSchema, healthStatusSchema } from './index';

describe('currencyListSchema', () => {
  it('normalizes a comma separated list to upper case codes', () => {
    expect(currencyListSchema.parse(' eur, GBP ,brl')).toEqual(['EUR', 'GBP', 'BRL']);
  });

  it('rejects codes that are not three letters', () => {
    expect(currencyListSchema.safeParse('EURO,GBP').success).toBe(false);
  });

  it('rejects an empty list', () => {
    expect(currencyListSchema.safeParse(' , ').success).toBe(false);
  });
});

describe('healthStatusSchema', () => {
  it('accepts a healthy payload', () => {
    expect(healthStatusSchema.parse({ status: 'ok', checks: { database: 'up', redis: 'up' } }).status).toBe('ok');
  });
});
