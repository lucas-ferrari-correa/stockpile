import { z } from 'zod';

const envSchema = z.object({
  VITE_API_URL: z.url().default('http://localhost:3000'),
});

export type Env = z.infer<typeof envSchema>;

export const env: Env = envSchema.parse(import.meta.env);
