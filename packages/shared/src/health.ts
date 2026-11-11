import { z } from 'zod';

export const healthStatusSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  checks: z.object({
    database: z.enum(['up', 'down']),
    redis: z.enum(['up', 'down']),
    queue: z.enum(['up', 'down']),
  }),
});

export type HealthStatus = z.infer<typeof healthStatusSchema>;
