import { describe, expect, it, vi } from 'vitest';
import { createHttpClient, type FetchLike, type HttpClient } from './http';
import { HttpError } from './http-error';
import { createRole, deleteRole, getRole, listRoles, updateRole } from './roles';

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
