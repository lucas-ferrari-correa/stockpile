import { z } from 'zod';

export function encodeListingCursor(cursor: object): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeListingCursor<T>(token: string, schema: z.ZodType<T>): T | null {
  let payload: unknown;

  try {
    payload = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  const parsed = schema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}
