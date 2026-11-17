export interface CursorInfiniteQueryOptions<TPage, TKey extends readonly unknown[]> {
  queryKey: TKey;
  queryFn: (context: { pageParam: string | undefined; signal: AbortSignal }) => Promise<TPage>;
  initialPageParam: string | undefined;
  getNextPageParam: (page: TPage) => string | undefined;
}

function append(search: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined || value === null || value === '') return;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    search.append(key, String(value));
  }
}

export function listingSearchParams(params: object): URLSearchParams {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) append(search, key, item);
    } else {
      append(search, key, value);
    }
  }
  return search;
}

export function listingPath(path: string, params: object): string {
  const search = listingSearchParams(params).toString();
  return search.length > 0 ? `${path}?${search}` : path;
}
