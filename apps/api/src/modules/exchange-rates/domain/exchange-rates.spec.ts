import { convertCents, missingCurrencies } from './exchange-rates';

describe('exchange rates', () => {
  describe('convertCents', () => {
    it.each<[number, number | string, number]>([
      [1, 0.5, 1],
      [3, 0.5, 2],
      [1, 0.49, 0],
      [7, 0.07, 0],
      [1000, 0.865, 865],
      [0, 4000.548, 0],
      [50_000_000, 1.5e-7, 8],
      [2, '2.5e2', 500],
      [4, '1.25', 5],
      [100, 1e-7, 0],
    ])('converts %p cents at rate %p to %p cents', (priceCents, rate, expected) => {
      expect(convertCents(priceCents, rate)).toBe(expected);
    });

    it.each<[number, number, number]>([
      [100, 1.005, 101],
      [100, 150.015, 15002],
      [8375, 4000.548, 33504590],
    ])('rounds %p cents at rate %p half-up to %p where float multiplication drifts below the half', (priceCents, rate, expected) => {
      expect(Math.round(priceCents * rate)).toBe(expected - 1);
      expect(convertCents(priceCents, rate)).toBe(expected);
    });

    it('accepts a result exactly at the safe integer limit', () => {
      expect(convertCents(Number.MAX_SAFE_INTEGER, 1)).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('rejects a result beyond the safe integer limit', () => {
      expect(() => convertCents(Number.MAX_SAFE_INTEGER, 2)).toThrow(RangeError);
    });

    it.each<[number]>([[-1], [1.5], [Number.NaN], [Number.MAX_SAFE_INTEGER + 2]])(
      'rejects %p as a price in cents',
      (priceCents) => {
        expect(() => convertCents(priceCents, 1)).toThrow(RangeError);
      },
    );

    it.each<[number | string]>([
      [0],
      [-1],
      ['-0.5'],
      [Number.NaN],
      [Number.POSITIVE_INFINITY],
      [''],
      ['abc'],
      ['1,5'],
    ])('rejects %p as an exchange rate', (rate) => {
      expect(() => convertCents(100, rate)).toThrow(RangeError);
    });
  });

  describe('missingCurrencies', () => {
    it('lists the required currencies without a rate in the required order', () => {
      expect(missingCurrencies(['EUR', 'JPY', 'BRL', 'COP'], { JPY: 150, EUR: 0.9 })).toEqual(['BRL', 'COP']);
    });

    it('returns nothing when every required currency has a rate', () => {
      expect(missingCurrencies(['EUR', 'JPY'], { EUR: 0.9, JPY: 150, GBP: 0.8 })).toEqual([]);
    });
  });
});
