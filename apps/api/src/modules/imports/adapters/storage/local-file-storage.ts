import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { FactoryProvider } from '@nestjs/common';
import { AppConfigService } from '../../../../infra/config/app-config.service';
import { FILE_STORAGE, FileStorage, StoredFile } from '../../ports/file-storage';

export class LocalFileStorage implements FileStorage {
  constructor(private readonly directory: string) {}

  async save(source: Readable): Promise<StoredFile> {
    await mkdir(this.directory, { recursive: true });
    const path = join(this.directory, `${randomUUID()}.csv`);
    const target = createWriteStream(path, { flags: 'wx' });
    const hash = createHash('sha256');
    source.on('data', (chunk: Buffer) => hash.update(chunk));

    try {
      await pipeline(source, target);
    } catch (error) {
      await this.remove(path);
      throw error;
    }

    return { path, size: target.bytesWritten, sha256: hash.digest('hex') };
  }

  async open(path: string): Promise<Readable> {
    const stream = createReadStream(path);
    await once(stream, 'open');

    return stream;
  }

  async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  async remove(path: string): Promise<void> {
    await rm(path, { force: true });
  }
}

export const fileStorageProvider: FactoryProvider<FileStorage> = {
  provide: FILE_STORAGE,
  inject: [AppConfigService],
  useFactory: (config: AppConfigService): FileStorage => new LocalFileStorage(config.get('UPLOAD_DIR')),
};
