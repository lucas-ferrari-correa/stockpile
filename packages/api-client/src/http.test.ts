import { describe, expect, it, vi } from 'vitest';
import { createHttpClient, type FetchLike, type HttpClient } from './http';
import type { StockItemPage } from '@stockpile/shared';
import { HttpError } from './http-error';
import { listingPath, listingSearchParams } from './listing';
import { createRole, deleteRole, getRole, listRoles, updateRole } from './roles';
import { stockItemsInfiniteQueryOptions, stockItemsQueryKeys, stockItemsQueryOptions } from './stock-items';

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(response: () => Response): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return response();
  };
  return { fetch, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function headersOf(call: RecordedCall | undefined): Record<string, string> {
  return (call?.init?.headers ?? {}) as Record<string, string>;
}

describe('createHttpClient', () => {
  it('injects the bearer token and returns the parsed json body', async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(200, { ok: true }));
    const client = createHttpClient({ baseUrl: 'http://api.test/', getToken: () => 'abc', fetch });

    const result = await client.get<{ ok: boolean }>('/health');

    expect(result).toEqual({ ok: true });
    expect(calls[0]?.url).toBe('http://api.test/health');
    expect(headersOf(calls[0]).Authorization).toBe('Bearer abc');
  });

  it('omits the authorization header when there is no token', async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(200, {}));
    const client = createHttpClient({ baseUrl: 'http://api.test', getToken: () => null, fetch });

    await client.get('/health');

    expect(headersOf(calls[0])).not.toHaveProperty('Authorization');
  });

  it('serializes json bodies and keeps form data untouched', async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(201, {}));
    const client = createHttpClient({ baseUrl: 'http://api.test', fetch });
    const form = new FormData();
    form.append('file', new Blob(['a,b']), 'data.csv');

    await client.post('/items', { name: 'x' });
    await client.post('/imports', form);

    expect(calls[0]?.init?.body).toBe('{"name":"x"}');
    expect(headersOf(calls[0])['Content-Type']).toBe('application/json');
    expect(calls[1]?.init?.body).toBe(form);
    expect(headersOf(calls[1])).not.toHaveProperty('Content-Type');
  });

  it('calls onUnauthorized and throws an HttpError on 401', async () => {
    const { fetch } = fakeFetch(() => jsonResponse(401, { message: 'Unauthorized' }));
    const onUnauthorized = vi.fn();
    const client = createHttpClient({ baseUrl: 'http://api.test', getToken: () => 'expired', onUnauthorized, fetch });

    const error = await client.get('/me').catch((e: unknown) => e);

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 401, message: 'Unauthorized' });
  });

  it('throws an HttpError with status and body on non-2xx responses without calling onUnauthorized', async () => {
    const body = { message: 'Invalid file', errors: [{ field: 'file' }] };
    const { fetch } = fakeFetch(() => jsonResponse(422, body));
    const onUnauthorized = vi.fn();
    const client = createHttpClient({ baseUrl: 'http://api.test', onUnauthorized, fetch });

    const error = await client.post('/imports', {}).catch((e: unknown) => e);

    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 422, body, message: 'Invalid file' });
  });

  it('keeps a non-json error body as text', async () => {
    const { fetch } = fakeFetch(() => new Response('Bad Gateway', { status: 502, headers: { 'content-type': 'text/plain' } }));
    const client = createHttpClient({ baseUrl: 'http://api.test', fetch });

    const error = await client.get('/health').catch((e: unknown) => e);

    expect(error).toMatchObject({ status: 502, body: 'Bad Gateway', message: 'Request failed with status 502' });
  });

  it('returns undefined for empty responses', async () => {
    const { fetch } = fakeFetch(() => new Response(null, { status: 204 }));
    const client = createHttpClient({ baseUrl: 'http://api.test', fetch });

    await expect(client.request('/items/1', { method: 'DELETE' })).resolves.toBeUndefined();
  });
});

describe('roles fetchers', () => {
  const ROLE_ID = '5b0f8a52-3c0e-4c4f-9d43-2f7a3c1c9e10';

  it.each([
    ['listRoles', (client: HttpClient) => listRoles(client), 'GET', '/roles', undefined],
    ['getRole', (client: HttpClient) => getRole(client, ROLE_ID), 'GET', `/roles/${ROLE_ID}`, undefined],
    [
      'createRole',
      (client: HttpClient) => createRole(client, { name: 'Auditor', permissions: ['inventory:read'] }),
      'POST',
      '/roles',
      { name: 'Auditor', permissions: ['inventory:read'] },
    ],
    [
      'updateRole',
      (client: HttpClient) => updateRole(client, ROLE_ID, { permissions: [] }),
      'PATCH',
      `/roles/${ROLE_ID}`,
      { permissions: [] },
    ],
    ['deleteRole', (client: HttpClient) => deleteRole(client, ROLE_ID), 'DELETE', `/roles/${ROLE_ID}`, undefined],
  ])('%s calls the roles endpoint with the expected method and body', async (_name, call, method, path, body) => {
    const { fetch, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    const client = createHttpClient({ baseUrl: 'http://api.test', fetch });

    await call(client);

    expect(calls[0]?.url).toBe(`http://api.test${path}`);
    expect(calls[0]?.init?.method).toBe(method);
    expect(calls[0]?.init?.body).toBe(body === undefined ? undefined : JSON.stringify(body));
  });
});

describe('listing serializer', () => {
  it('repeats multivalue parameters, stringifies scalars and drops empty values', () => {
    const search = listingSearchParams({
      q: 'cheese',
      category: ['Dairy', '', 'Bakery'],
      limit: 25,
      archived: false,
      cursor: undefined,
      brand: null,
      supplier: '',
      warehouse: [],
    });

    expect(search.toString()).toBe('q=cheese&category=Dairy&category=Bakery&limit=25&archived=false');
  });

  it('ignores nested objects instead of serializing them', () => {
    expect(listingSearchParams({ sort: 'sku', range: { from: 1 }, values: [{ id: 1 }, 'kept'] }).toString()).toBe('sort=sku&values=kept');
  });

  it('builds a path with an encoded query string, or the bare path when nothing remains', () => {
    expect(listingPath('/stock-items', { q: '50% off & more', minPrice: '12.50' })).toBe('/stock-items?q=50%25+off+%26+more&minPrice=12.50');
    expect(listingPath('/stock-items', { q: '', cursor: undefined, category: [] })).toBe('/stock-items');
  });
});

describe('stock items query options', () => {
  const PAGE: StockItemPage = { items: [], nextCursor: 'next-cursor', total: 0 };

  function pageClient(pages: StockItemPage[] = [PAGE]): { client: HttpClient; calls: RecordedCall[] } {
    const queue = [...pages];
    const { fetch, calls } = fakeFetch(() => jsonResponse(200, queue.shift() ?? PAGE));
    return { client: createHttpClient({ baseUrl: 'http://api.test', fetch }), calls };
  }

  it('keys single pages and infinite lists apart under the shared stock items prefix', () => {
    const params = { importId: 'import-1', category: ['Dairy'], sort: 'name' as const };

    const list = stockItemsQueryKeys.list(params);
    const infinite = stockItemsQueryKeys.listInfinite(params);

    expect(list).toEqual(['stock-items', 'list', params]);
    expect(infinite).toEqual(['stock-items', 'list', 'infinite', params]);
    expect(list.slice(0, 1)).toEqual(stockItemsQueryKeys.all);
    expect(stockItemsQueryKeys.list({ sort: 'sku' })).not.toEqual(list);
  });

  it('fetches one page with the serialized filters and forwards the abort signal', async () => {
    const { client, calls } = pageClient();
    const controller = new AbortController();
    const options = stockItemsQueryOptions(client, { category: ['Dairy', 'Bakery'], minPrice: '2.50', expiration: 'none', limit: 10 });

    const result = await options.queryFn({ signal: controller.signal });

    expect(result).toEqual(PAGE);
    expect(options.queryKey).toEqual(stockItemsQueryKeys.list({ category: ['Dairy', 'Bakery'], minPrice: '2.50', expiration: 'none', limit: 10 }));
    expect(calls[0]?.url).toBe('http://api.test/stock-items?category=Dairy&category=Bakery&minPrice=2.50&expiration=none&limit=10');
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init?.signal).toBe(controller.signal);
  });

  it('starts an infinite list without a cursor and passes each next cursor back until the last page', async () => {
    const last: StockItemPage = { items: [], nextCursor: null, total: null };
    const { client, calls } = pageClient([PAGE, last]);
    const options = stockItemsInfiniteQueryOptions(client, { sort: 'unitPrice', order: 'desc' });
    const signal = new AbortController().signal;

    const first = await options.queryFn({ pageParam: options.initialPageParam, signal });
    const second = await options.queryFn({ pageParam: options.getNextPageParam(first), signal });

    expect(options.initialPageParam).toBeUndefined();
    expect(calls.map((call) => call.url)).toEqual([
      'http://api.test/stock-items?sort=unitPrice&order=desc',
      'http://api.test/stock-items?sort=unitPrice&order=desc&cursor=next-cursor',
    ]);
    expect(options.getNextPageParam(second)).toBeUndefined();
  });
});
