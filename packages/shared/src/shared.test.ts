import { describe, expect, it } from 'vitest';
import { ROLE_NAME_MAX_LENGTH, createRoleSchema, currencyListSchema, healthStatusSchema, updateRoleSchema } from './index';

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

describe('createRoleSchema', () => {
  it('trims the name and keeps catalog permissions', () => {
    expect(createRoleSchema.parse({ name: '  Auditors ', permissions: ['inventory:read'] })).toEqual({
      name: 'Auditors',
      permissions: ['inventory:read'],
    });
  });

  it.each([
    ['a blank name', { name: '   ', permissions: [] }],
    ['a name longer than the limit', { name: 'x'.repeat(ROLE_NAME_MAX_LENGTH + 1), permissions: [] }],
    ['a permission outside the catalog', { name: 'Ops', permissions: ['inventory:delete'] }],
    ['a duplicated permission', { name: 'Ops', permissions: ['inventory:read', 'inventory:read'] }],
  ])('rejects %s', (_case, body) => {
    expect(createRoleSchema.safeParse(body).success).toBe(false);
  });
});

describe('updateRoleSchema', () => {
  it.each([
    [{ name: 'Ops' }],
    [{ permissions: [] }],
    [{ name: 'Ops', permissions: ['roles:manage'] }],
  ])('accepts %j', (body) => {
    expect(updateRoleSchema.safeParse(body).success).toBe(true);
  });

  it('rejects an empty body', () => {
    expect(updateRoleSchema.safeParse({}).success).toBe(false);
  });
});
