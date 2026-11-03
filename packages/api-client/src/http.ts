import { HttpError } from './http-error';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  baseUrl: string;
  getToken?: () => string | null | undefined;
  onUnauthorized?: () => void;
  fetch?: FetchLike;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface HttpClient {
  request<T>(path: string, options?: RequestOptions): Promise<T>;
  get<T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T>;
  post<T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T>;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function isBodyInit(body: unknown): body is FormData | Blob | URLSearchParams {
  return (
    (typeof FormData !== 'undefined' && body instanceof FormData) ||
    (typeof Blob !== 'undefined' && body instanceof Blob) ||
    (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams)
  );
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function extractMessage(body: unknown): string | undefined {
  if (typeof body === 'object' && body !== null && 'message' in body) {
    const { message } = body as { message: unknown };
    if (typeof message === 'string') return message;
  }
  return undefined;
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  async function request<T>(path: string, requestOptions: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json', ...requestOptions.headers };
    const token = options.getToken?.();
    if (token) headers.Authorization = `Bearer ${token}`;

    let body: BodyInit | undefined;
    if (requestOptions.body !== undefined) {
      if (isBodyInit(requestOptions.body)) {
        body = requestOptions.body;
      } else {
        body = JSON.stringify(requestOptions.body);
        headers['Content-Type'] = 'application/json';
      }
    }

    const response = await fetchImpl(joinUrl(options.baseUrl, path), {
      method: requestOptions.method ?? 'GET',
      headers,
      body,
      signal: requestOptions.signal,
    });

    const parsed = await parseBody(response);

    if (response.status === 401) options.onUnauthorized?.();
    if (!response.ok) throw new HttpError(response.status, parsed, extractMessage(parsed));

    return parsed as T;
  }

  return {
    request,
    get: (path, getOptions) => request(path, { ...getOptions, method: 'GET' }),
    post: (path, body, postOptions) => request(path, { ...postOptions, method: 'POST', body }),
  };
}
