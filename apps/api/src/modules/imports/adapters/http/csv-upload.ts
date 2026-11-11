import { basename, extname } from 'node:path';
import { Readable } from 'node:stream';
import { HttpException } from '@nestjs/common';
import { IMPORT_FILE_FIELD } from '@stockpile/shared';
import busboy from 'busboy';
import { Request } from 'express';
import { UploadedCsv } from '../../application/imports.service';
import { fileTooLarge, invalidUpload } from '../../application/imports.errors';
import { FileStorage, StoredFile } from '../../ports/file-storage';

const CSV_EXTENSION = '.csv';

interface PendingFile {
  fileName: string;
  stream: Readable & { truncated?: boolean };
  saving: Promise<StoredFile>;
}

function createParser(request: Request, maxBytes: number): busboy.Busboy {
  try {
    return busboy({ headers: request.headers, limits: { files: 1, fileSize: maxBytes } });
  } catch {
    throw invalidUpload('INVALID_MULTIPART');
  }
}

async function discard(pending: PendingFile | undefined, storage: FileStorage): Promise<void> {
  if (!pending) {
    return;
  }
  pending.stream.destroy();
  const stored = await pending.saving.catch((): undefined => undefined);
  if (stored) {
    await storage.remove(stored.path);
  }
}

export async function receiveCsvUpload(request: Request, storage: FileStorage, maxBytes: number): Promise<UploadedCsv> {
  const parser = createParser(request, maxBytes);
  let pending: PendingFile | undefined;
  let rejection: HttpException | undefined;

  parser.on('file', (field, stream, info) => {
    if (field !== IMPORT_FILE_FIELD || pending !== undefined) {
      stream.resume();
      return;
    }

    const fileName = basename(info.filename ?? '');
    if (extname(fileName).toLowerCase() !== CSV_EXTENSION) {
      rejection = invalidUpload('INVALID_FILE_TYPE');
      stream.resume();
      return;
    }

    const saving = storage.save(stream);
    saving.catch((): undefined => undefined);
    pending = { fileName, stream, saving };
  });

  const parsed = new Promise<void>((resolve, reject) => {
    parser.once('close', () => resolve());
    parser.once('error', () => reject(invalidUpload('INVALID_MULTIPART')));
    request.once('close', () => {
      if (!request.complete) {
        reject(invalidUpload('INVALID_MULTIPART'));
      }
    });
  });
  request.pipe(parser);

  try {
    await parsed;
  } catch (error) {
    await discard(pending, storage);
    throw error;
  }

  if (!pending) {
    throw rejection ?? invalidUpload('FILE_REQUIRED');
  }

  const stored = await pending.saving;
  if (pending.stream.truncated === true) {
    await storage.remove(stored.path);
    throw fileTooLarge();
  }

  return { fileName: pending.fileName, filePath: stored.path, contentSha256: stored.sha256 };
}
