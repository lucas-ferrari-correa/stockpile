import { createHttpClient, type HttpClient } from '@stockpile/api-client';
import { env } from './env';

export const http: HttpClient = createHttpClient({ baseUrl: env.VITE_API_URL });
