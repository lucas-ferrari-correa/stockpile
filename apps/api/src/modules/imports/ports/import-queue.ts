import { z } from 'zod';

export const importJobPayloadSchema = z.object({
  importId: z.uuid(),
  filePath: z.string().min(1),
});

export type ImportJobPayload = z.infer<typeof importJobPayloadSchema>;

export interface ImportQueue {
  enqueue(payload: ImportJobPayload): Promise<void>;
  isQueued(importId: string): Promise<boolean>;
  isReady(): Promise<boolean>;
}

export const IMPORT_QUEUE = Symbol('IMPORT_QUEUE');
