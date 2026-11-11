import { Readable } from 'node:stream';

export interface StoredFile {
  path: string;
  size: number;
  sha256: string;
}

export interface FileStorage {
  save(source: Readable): Promise<StoredFile>;
  open(path: string): Promise<Readable>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
}

export const FILE_STORAGE = Symbol('FILE_STORAGE');
