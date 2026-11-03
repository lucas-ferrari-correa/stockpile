import { z } from 'zod';

export const BASE_CURRENCY = 'USD';

export const DEFAULT_CONVERSION_CURRENCIES = ['EUR', 'GBP', 'JPY', 'CNY', 'CAD', 'BRL', 'COP'] as const;

export const currencyCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/)
  .transform((value) => value.toUpperCase());

export const currencyListSchema = z
  .string()
  .transform((value) => value.split(',').map((item) => item.trim()).filter((item) => item.length > 0))
  .pipe(z.array(currencyCodeSchema).min(1));
