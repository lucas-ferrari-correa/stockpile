import type { StockItemPage, StockItemsQueryParams } from '@stockpile/shared';
import type { HttpClient } from '../http';
import { listingPath, type CursorInfiniteQueryOptions } from '../listing';

export const stockItemsQueryKeys = {
  all: ['stock-items'] as const,
  list: (params: StockItemsQueryParams) => [...stockItemsQueryKeys.all, 'list', params] as const,
  listInfinite: (params: Omit<StockItemsQueryParams, 'cursor'>) =>
    [...stockItemsQueryKeys.all, 'list', 'infinite', params] as const,
};

export function fetchStockItems(
  http: HttpClient,
  params: StockItemsQueryParams,
  signal?: AbortSignal,
): Promise<StockItemPage> {
  return http.get<StockItemPage>(listingPath('/stock-items', params), { signal });
}

export function stockItemsQueryOptions(
  http: HttpClient,
  params: StockItemsQueryParams,
): {
  queryKey: ReturnType<typeof stockItemsQueryKeys.list>;
  queryFn: (context: { signal: AbortSignal }) => Promise<StockItemPage>;
} {
  return {
    queryKey: stockItemsQueryKeys.list(params),
    queryFn: ({ signal }) => fetchStockItems(http, params, signal),
  };
}

export function stockItemsInfiniteQueryOptions(
  http: HttpClient,
  params: Omit<StockItemsQueryParams, 'cursor'>,
): CursorInfiniteQueryOptions<StockItemPage, ReturnType<typeof stockItemsQueryKeys.listInfinite>> {
  return {
    queryKey: stockItemsQueryKeys.listInfinite(params),
    queryFn: ({ pageParam, signal }) => fetchStockItems(http, { ...params, cursor: pageParam }, signal),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  };
}
