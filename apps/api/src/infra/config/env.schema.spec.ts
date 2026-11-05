import { parseEnv } from './env.schema';

const validEnv = {
  DATABASE_URL: 'postgresql://stockpile:stockpile@localhost:5433/stockpile',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'test-only-jwt-secret-with-at-least-32-chars',
};

describe('parseEnv', () => {
  it('applies defaults when optional variables are missing', () => {
    const env = parseEnv(validEnv);

    expect(env.PORT).toBe(3000);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.EXCHANGE_CURRENCIES).toEqual(['EUR', 'GBP', 'JPY', 'CNY', 'CAD', 'BRL', 'COP']);
  });

  it('normalizes the configured currency list', () => {
    expect(parseEnv({ ...validEnv, EXCHANGE_CURRENCIES: 'eur, brl' }).EXCHANGE_CURRENCIES).toEqual(['EUR', 'BRL']);
  });

  it('coerces the port to a number', () => {
    expect(parseEnv({ ...validEnv, PORT: '3001' }).PORT).toBe(3001);
  });

  it('fails naming the missing database url', () => {
    expect(() => parseEnv({ REDIS_URL: validEnv.REDIS_URL })).toThrow(/DATABASE_URL/);
  });

  it('fails on an invalid currency code', () => {
    expect(() => parseEnv({ ...validEnv, EXCHANGE_CURRENCIES: 'EURO' })).toThrow(/EXCHANGE_CURRENCIES/);
  });

  it('fails on a non numeric port', () => {
    expect(() => parseEnv({ ...validEnv, PORT: 'abc' })).toThrow(/PORT/);
  });

  it('fails on an unknown log level', () => {
    expect(() => parseEnv({ ...validEnv, LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
  });
});
