import { healthStatusSchema, type HealthStatus } from '@stockpile/shared';
import { queryOptions } from '@tanstack/react-query';
import { http } from '@/lib/api';

export const healthQueryOptions = () =>
  queryOptions({
    queryKey: ['health'],
    queryFn: async ({ signal }): Promise<HealthStatus> => healthStatusSchema.parse(await http.get<unknown>('/health', { signal })),
  });
