import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import {
  BASE_CURRENCY,
  INVENTORY_CSV_HEADER,
  ImportDetail,
  ImportStatus,
  PERMISSIONS,
  Permission,
  importDetailSchema,
  loginResponseSchema,
  ratesUnavailableErrorSchema,
} from '@stockpile/shared';
import { Job, Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { DOCS_PATH, configureApp } from '../src/app.setup';
import { AppConfigService } from '../src/infra/config/app-config.service';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { PASSWORD_HASHER, PasswordHasher } from '../src/modules/auth/ports/password-hasher.port';
import {
  EXCHANGE_RATES_PROVIDER,
  ExchangeRatesProvider,
  ExchangeRatesUnavailableError,
  LatestRates,
} from '../src/modules/exchange-rates/ports/exchange-rates.provider';
import { BullMqImportQueue } from '../src/modules/imports/adapters/queue/bullmq-import-queue';
import { ImportProcessor } from '../src/modules/imports/adapters/queue/import.processor';
import { IMPORTS_QUEUE, IMPORT_JOB_NAME } from '../src/modules/imports/adapters/queue/imports-queue.constants';
import { LocalFileStorage } from '../src/modules/imports/adapters/storage/local-file-storage';
import { ImportProcessingService } from '../src/modules/imports/application/import-processing.service';
import { ImportRecoveryService, ImportRecoverySummary } from '../src/modules/imports/application/import-recovery.service';
import { IMPORT_FILE_MISSING_REASON, IMPORT_INTERRUPTED_REASON } from '../src/modules/imports/application/imports.errors';
import { ExchangeRatesService } from '../src/modules/exchange-rates/application/exchange-rates.service';
import { ImportsWorkerModule } from '../src/modules/imports/imports-worker.module';
import { FILE_STORAGE } from '../src/modules/imports/ports/file-storage';
import { IMPORT_QUEUE, ImportJobPayload, ImportQueue, importJobPayloadSchema } from '../src/modules/imports/ports/import-queue';
import { seedRoles } from '../src/seed/admin-seed';

const PASSWORD = 'importer-password-0123';
const UPLOAD_MAX_BYTES = 48 * 1024 * 1024;
const LARGE_FILE_BYTES = 40 * 1024 * 1024;
const JOB_ATTEMPTS = 3;
const IMPORTER: readonly Permission[] = ['imports:manage'];
const RECONCILE_AFTER_MS = 60000;
const NOTHING_RECOVERED: ImportRecoverySummary = { interrupted: 0, fileMissing: 0, requeued: 0 };

interface SeededUser {
  id: string;
  email: string;
  token: string;
}

interface UploadFile {
  content: string | Buffer;
  name: string;
}

interface Deferred {
  promise: Promise<void>;
  release(): void;
}

type SeedImportData = Partial<Omit<Prisma.ImportUncheckedCreateInput, 'createdById'>>;

function deferred(): Deferred {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function csvRow(index: number): string {
  return `SKU-${index};Product ${index};Tools;Acme;Supplier ${index % 7};US;WH-1;LOT-${index};${index % 50};${index}.10;${index}.90;2030-01-02`;
}

function csvRows(count: number, eol = '\n'): string {
  const rows = Array.from({ length: count }, (_, index) => csvRow(index));
  return [INVENTORY_CSV_HEADER, ...rows].join(eol) + eol;
}

function* largeCsv(minBytes: number): Generator<string> {
  yield `${INVENTORY_CSV_HEADER}\n`;
  let written = INVENTORY_CSV_HEADER.length + 1;
  let row = 0;
  while (written < minBytes) {
    const line = `${csvRow(row)};${'Synthetic product '.padEnd(160, 'x')}\n`;
    written += Buffer.byteLength(line);
    row += 1;
    yield line;
  }
}

async function writeLargeCsv(path: string, minBytes: number): Promise<void> {
  await pipeline(Readable.from(largeCsv(minBytes)), createWriteStream(path));
}

async function* failMidway(source: Readable): AsyncGenerator<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const content = Buffer.concat(chunks);
  yield content.subarray(0, Math.floor(content.length * 0.6));
  throw new Error('Simulated read failure');
}

class FlakyFileStorage extends LocalFileStorage {
  failuresLeft = 0;
  gate: Promise<void> = Promise.resolve();

  override async open(path: string): Promise<Readable> {
    await this.gate;
    const source = await super.open(path);
    if (this.failuresLeft <= 0) {
      return source;
    }
    this.failuresLeft -= 1;
    return Readable.from(failMidway(source));
  }
}

class FlakyImportQueue implements ImportQueue {
  enqueueFailuresLeft = 0;

  constructor(private readonly inner: ImportQueue) {}

  async enqueue(payload: ImportJobPayload): Promise<void> {
    if (this.enqueueFailuresLeft > 0) {
      this.enqueueFailuresLeft -= 1;
      throw new Error('Simulated enqueue failure');
    }
    await this.inner.enqueue(payload);
  }

  isQueued(importId: string): Promise<boolean> {
    return this.inner.isQueued(importId);
  }

  isReady(): Promise<boolean> {
    return this.inner.isReady();
  }
}

class FakeRatesProvider implements ExchangeRatesProvider {
  next: LatestRates | Error = { date: '2026-03-04', rates: {}, source: 'fake.test' };
  gate: Promise<void> = Promise.resolve();

  async fetchLatest(): Promise<LatestRates> {
    await this.gate;
    if (this.next instanceof Error) {
      throw this.next;
    }
    return this.next;
  }
}

function liveMemory(): number {
  const gc: unknown = runInNewContext('gc');
  if (typeof gc === 'function') {
    Reflect.apply(gc, undefined, []);
  }
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.arrayBuffers;
}

function samplePeakMemory(): () => number {
  const baseline = liveMemory();
  let peak = 0;
  let timer: NodeJS.Timeout | undefined;
  const sample = (): void => {
    const started = performance.now();
    peak = Math.max(peak, liveMemory() - baseline);
    timer = setTimeout(sample, Math.max(50, (performance.now() - started) * 4));
  };
  timer = setTimeout(sample, 50);
  return () => {
    clearTimeout(timer);
    return peak;
  };
}

async function waitFor<T>(probe: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 15000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (accept(value)) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Condition not met in ${timeoutMs}ms, last value: ${JSON.stringify(value)}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

setFlagsFromString('--expose-gc');

describe('imports', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let queue: Queue<ImportJobPayload>;
  let processor: ImportProcessor;
  let uploadDir: string;
  let fixturesDir: string;
  let passwordHash: string;
  let storage: FlakyFileStorage;
  let validRates: LatestRates;
  let viewerRoleId: string;
  let importQueue: FlakyImportQueue;
  const rates = new FakeRatesProvider();

  async function createRole(permissions: readonly Permission[]): Promise<string> {
    const role = await prisma.role.create({
      data: {
        name: `custom-${randomUUID()}`,
        permissions: { createMany: { data: permissions.map((permission) => ({ permission })) } },
      },
      select: { id: true },
    });
    return role.id;
  }

  async function seedUserWithRole(roleId: string): Promise<SeededUser> {
    const user = await prisma.user.create({
      data: { name: 'Importer', email: `${randomUUID()}@example.test`, passwordHash, status: 'ACTIVE', roleId },
      select: { id: true, email: true },
    });
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: user.email, password: PASSWORD })
      .expect(200);
    return { ...user, token: loginResponseSchema.parse(response.body).accessToken };
  }

  async function seedUser(permissions: readonly Permission[] = IMPORTER): Promise<SeededUser> {
    return seedUserWithRole(await createRole(permissions));
  }

  function upload(token: string | undefined, file?: UploadFile | string): request.Test {
    const pending = request(app.getHttpServer()).post('/imports');
    const authed = token === undefined ? pending : pending.auth(token, { type: 'bearer' });
    if (file === undefined) {
      return authed.field('note', 'no file here');
    }
    return typeof file === 'string'
      ? authed.attach('file', file)
      : authed.attach('file', Buffer.from(file.content), file.name);
  }

  function getImport(id: string, token?: string): request.Test {
    const pending = request(app.getHttpServer()).get(`/imports/${id}`);
    return token === undefined ? pending : pending.auth(token, { type: 'bearer' });
  }

  function acceptedId(response: request.Response): string {
    const body = response.body as { importId: string };
    expect(Object.keys(body)).toEqual(['importId']);
    return body.importId;
  }

  async function statusOf(importId: string): Promise<ImportStatus | undefined> {
    const row = await prisma.import.findUnique({ where: { id: importId }, select: { status: true } });
    return row?.status;
  }

  async function finished(importId: string): Promise<ImportStatus | undefined> {
    return waitFor(
      () => statusOf(importId),
      (status) => status === 'completed' || status === 'failed',
    );
  }

  async function importFile(token: string, file: UploadFile): Promise<string> {
    const importId = acceptedId(await upload(token, file).expect(202));
    expect(await finished(importId)).toBe('completed');
    return importId;
  }

  async function uploadedFiles(): Promise<string[]> {
    return readdir(uploadDir).catch((): string[] => []);
  }

  async function seedImport(createdById: string, data: SeedImportData = {}): Promise<string> {
    const created = await prisma.import.create({
      data: { fileName: 'seeded.csv', ...data, createdById },
      select: { id: true },
    });
    return created.id;
  }

  async function storedFile(content: string): Promise<string> {
    return (await storage.save(Readable.from([Buffer.from(content)]))).path;
  }

  async function seedStaleImport(createdById: string, data: SeedImportData, withSnapshot: boolean): Promise<string> {
    const importId = await seedImport(createdById, data);
    if (withSnapshot) {
      await app.get(ExchangeRatesService).captureSnapshot(importId);
    }
    return importId;
  }

  function reconcileLater(): Promise<ImportRecoverySummary> {
    return app.get(ImportRecoveryService).reconcile(new Date(Date.now() + 2 * RECONCILE_AFTER_MS));
  }

  async function failureOf(importId: string): Promise<{ status: ImportStatus; failureReason: string | null }> {
    return prisma.import.findUniqueOrThrow({ where: { id: importId }, select: { status: true, failureReason: true } });
  }

  beforeAll(async () => {
    uploadDir = await mkdtemp(join(tmpdir(), 'stockpile-imports-test-'));
    fixturesDir = await mkdtemp(join(tmpdir(), 'stockpile-imports-fixtures-'));
    const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
    redisUrl.pathname = '/14';
    Object.assign(process.env, {
      REDIS_URL: redisUrl.toString(),
      UPLOAD_DIR: uploadDir,
      UPLOAD_MAX_BYTES: String(UPLOAD_MAX_BYTES),
      IMPORT_JOB_ATTEMPTS: String(JOB_ATTEMPTS),
      IMPORT_JOB_BACKOFF_MS: '20',
      IMPORT_CONCURRENCY: '2',
      IMPORT_RECONCILE_INTERVAL_MS: '3600000',
      IMPORT_RECONCILE_AFTER_MS: String(RECONCILE_AFTER_MS),
    });
    storage = new FlakyFileStorage(uploadDir);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule, ImportsWorkerModule] })
      .overrideProvider(EXCHANGE_RATES_PROVIDER)
      .useValue(rates)
      .overrideProvider(FILE_STORAGE)
      .useValue(storage)
      .overrideProvider(IMPORT_QUEUE)
      .useFactory({
        inject: [getQueueToken(IMPORTS_QUEUE), AppConfigService],
        factory: (bull: Queue<ImportJobPayload>, config: AppConfigService): ImportQueue => {
          importQueue = new FlakyImportQueue(new BullMqImportQueue(bull, config));
          return importQueue;
        },
      })
      .compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    queue = app.get<Queue<ImportJobPayload>>(getQueueToken(IMPORTS_QUEUE));
    processor = app.get(ImportProcessor);
    passwordHash = await app.get<PasswordHasher>(PASSWORD_HASHER).hash(PASSWORD);
    const currencies = app.get(AppConfigService).get('EXCHANGE_CURRENCIES');
    validRates = {
      date: '2026-03-04',
      rates: Object.fromEntries(currencies.map((code, index) => [code, index + 1.5])),
      source: 'rates.example.test',
    };
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
    await prisma.import.deleteMany();
    await prisma.user.deleteMany();
    await prisma.role.deleteMany();
    ({ viewerRoleId } = await seedRoles(prisma));
    await rm(uploadDir, { recursive: true, force: true });
    await mkdir(uploadDir, { recursive: true });
    storage.failuresLeft = 0;
    storage.gate = Promise.resolve();
    importQueue.enqueueFailuresLeft = 0;
    rates.gate = Promise.resolve();
    rates.next = validRates;
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await prisma.import.deleteMany();
    await prisma.user.deleteMany();
    await app.close();
    await rm(uploadDir, { recursive: true, force: true });
    await rm(fixturesDir, { recursive: true, force: true });
  });

  describe('upload', () => {
    it('moves an accepted import from pending through processing to completed', async () => {
      const user = await seedUser();
      const ratesHeld = deferred();
      const readHeld = deferred();
      rates.gate = ratesHeld.promise;
      storage.gate = readHeld.promise;

      const uploading: Promise<request.Response> = upload(user.token, { content: csvRows(3), name: 'products.csv' })
        .expect(202)
        .then((response) => response);
      const pending = await waitFor(
        () => prisma.import.findFirst({ where: { createdById: user.id }, select: { status: true } }),
        (row) => row !== null,
      );
      expect(pending?.status).toBe('pending');
      ratesHeld.release();
      const importId = acceptedId(await uploading);

      await waitFor(() => statusOf(importId), (status) => status === 'processing');
      const job = await queue.getJob(importId);
      expect(job?.id).toBe(importId);
      expect(job?.data).toEqual({ importId, filePath: expect.stringContaining(uploadDir) as string });
      expect(job?.opts).toMatchObject({ attempts: JOB_ATTEMPTS, backoff: { type: 'exponential', delay: 20 } });
      expect(await job?.getState()).toBe('active');
      const processing = await getImport(importId, user.token).expect(200);
      expect(processing.body).toMatchObject({ id: importId, status: 'processing', totalRows: null });
      readHeld.release();

      expect(await finished(importId)).toBe('completed');
      const completed = await getImport(importId, user.token).expect(200);
      expect(importDetailSchema.parse(completed.body)).toEqual({
        id: importId,
        status: 'completed',
        fileName: 'products.csv',
        totalRows: 3,
        processedRows: 3,
        acceptedRows: 0,
        rejectedRows: 0,
        rejectedByReason: {},
        failureReason: null,
        createdAt: expect.any(String) as string,
        updatedAt: expect.any(String) as string,
        rates: { date: validRates.date, base: BASE_CURRENCY },
      } satisfies ImportDetail);
      expect(await uploadedFiles()).toEqual([]);
    });

    it.each<[string, string, number]>([
      ['LF line endings', csvRows(5), 5],
      ['CRLF line endings', csvRows(4, '\r\n'), 4],
      ['no trailing newline', csvRows(2).trimEnd(), 2],
      ['blank lines between rows', `${INVENTORY_CSV_HEADER}\n\n${csvRow(1)}\n   \n${csvRow(2)}\n\n`, 2],
      ['only a header', `${INVENTORY_CSV_HEADER}\n`, 0],
      ['an empty file', '', 0],
    ])('counts data rows of a file with %s', async (_label, content, expected) => {
      const user = await seedUser();

      const importId = acceptedId(await upload(user.token, { content, name: 'rows.CSV' }).expect(202));

      expect(await finished(importId)).toBe('completed');
      const row = await prisma.import.findUniqueOrThrow({
        where: { id: importId },
        select: { totalRows: true, processedRows: true, fileName: true },
      });
      expect(row).toEqual({ totalRows: expected, processedRows: expected, fileName: 'rows.CSV' });
    });

    it('streams a file of tens of megabytes to storage without holding it in memory', async () => {
      const user = await seedUser();
      const path = join(fixturesDir, 'large.csv');
      await writeLargeCsv(path, LARGE_FILE_BYTES);
      const source = createHash('sha256');
      for await (const chunk of createReadStream(path)) {
        source.update(chunk as Buffer);
      }
      const readHeld = deferred();
      storage.gate = readHeld.promise;
      const stopSampling = samplePeakMemory();

      let response: request.Response;
      let peak: number;
      try {
        response = await upload(user.token, path).expect(202);
      } finally {
        peak = stopSampling();
      }

      try {
        expect(peak).toBeLessThan(LARGE_FILE_BYTES / 8);
        const importId = acceptedId(response);
        const job = await queue.getJob(importId);
        const storedPath = importJobPayloadSchema.parse(job?.data).filePath;
        expect((await stat(storedPath)).size).toBe((await stat(path)).size);
        const row = await prisma.import.findUniqueOrThrow({ where: { id: importId }, select: { contentSha256: true } });
        expect(row.contentSha256).toBe(source.digest('hex'));

        await writeFile(storedPath, `${INVENTORY_CSV_HEADER}\n`);
        readHeld.release();
        expect(await finished(importId)).toBe('completed');
      } finally {
        readHeld.release();
      }
    }, 120000);

    it('answers 503 and keeps the import failed without enqueueing when exchange rates are unavailable', async () => {
      const user = await seedUser();
      rates.next = new ExchangeRatesUnavailableError(BASE_CURRENCY, ['primary down', 'fallback down']);

      const response = await upload(user.token, { content: csvRows(2), name: 'products.csv' }).expect(503);

      const body = ratesUnavailableErrorSchema.parse(response.body);
      expect(body).toEqual({
        statusCode: 503,
        code: 'RATES_UNAVAILABLE',
        message: 'The exchange rates could not be captured, the import was marked as failed',
        importId: expect.any(String) as string,
      });
      const importId = body.importId;
      const row = await prisma.import.findUniqueOrThrow({
        where: { id: importId },
        select: { status: true, failureReason: true, totalRows: true },
      });
      expect(row.status).toBe('failed');
      expect(row.failureReason).toMatch(/^RATES_UNAVAILABLE: /);
      expect(row.totalRows).toBeNull();
      expect(await queue.getJob(importId)).toBeUndefined();
      expect(await queue.count()).toBe(0);
      expect(await uploadedFiles()).toEqual([]);
      const detail = await getImport(importId, user.token).expect(200);
      expect(detail.body).toMatchObject({ status: 'failed', failureReason: row.failureReason, rates: null });
    });

    it.each<[string, UploadFile | undefined, number, string]>([
      ['a file without the csv extension', { content: csvRows(1), name: 'products.txt' }, 400, 'INVALID_FILE_TYPE'],
      ['a file without any extension', { content: csvRows(1), name: 'products' }, 400, 'INVALID_FILE_TYPE'],
      ['a request without the file field', undefined, 400, 'FILE_REQUIRED'],
    ])('rejects %s without creating an import or leaving files', async (_label, file, status, code) => {
      const user = await seedUser();

      const response = await upload(user.token, file).expect(status);

      expect(response.body).toMatchObject({ statusCode: status, code });
      expect(await prisma.import.count()).toBe(0);
      expect(await queue.count()).toBe(0);
      expect(await uploadedFiles()).toEqual([]);
    });

    it('rejects a non multipart body without creating an import', async () => {
      const user = await seedUser();

      const response = await request(app.getHttpServer())
        .post('/imports')
        .auth(user.token, { type: 'bearer' })
        .send({ file: 'not-a-file' })
        .expect(400);

      expect(response.body).toMatchObject({ code: 'INVALID_MULTIPART' });
      expect(await prisma.import.count()).toBe(0);
    });

    it('rejects a file above the upload limit with 413 without creating an import or leaving files', async () => {
      const user = await seedUser();
      const path = join(fixturesDir, 'oversized.csv');
      await writeLargeCsv(path, UPLOAD_MAX_BYTES + 1024);

      const response = await upload(user.token, path).expect(413);

      expect(response.body).toMatchObject({ statusCode: 413, code: 'FILE_TOO_LARGE' });
      expect(await prisma.import.count()).toBe(0);
      expect(await queue.count()).toBe(0);
      expect(await uploadedFiles()).toEqual([]);
    }, 60000);

    describe('duplicate content', () => {
      const CONTENT = csvRows(2);

      it('rejects a second identical file with 409 pointing at the existing import, without creating, capturing or enqueueing', async () => {
        const owner = await seedUser();
        const existingImportId = await importFile(owner.token, { content: CONTENT, name: 'first.csv' });
        const jobs = await queue.count();

        const response = await upload(owner.token, { content: CONTENT, name: 'renamed.csv' }).expect(409);

        expect(response.body).toEqual({
          statusCode: 409,
          code: 'DUPLICATE_IMPORT',
          message: 'This file was already imported',
          existingImportId,
        });
        expect(await prisma.import.count()).toBe(1);
        expect(await prisma.exchangeRateSnapshot.count()).toBe(1);
        expect(await queue.count()).toBe(jobs);
        expect(await uploadedFiles()).toEqual([]);
        const stored = await prisma.import.findUniqueOrThrow({
          where: { id: existingImportId },
          select: { contentSha256: true },
        });
        expect(stored.contentSha256).toBe(sha256(CONTENT));
      });

      it('imports the same file again as a new import when forced', async () => {
        const owner = await seedUser();
        const existingImportId = await importFile(owner.token, { content: CONTENT, name: 'first.csv' });

        const forcedId = acceptedId(
          await upload(owner.token, { content: CONTENT, name: 'again.csv' }).query({ force: 'true' }).expect(202),
        );

        expect(forcedId).not.toBe(existingImportId);
        expect(await finished(forcedId)).toBe('completed');
        expect(await prisma.exchangeRateSnapshot.count()).toBe(2);
        const againId = acceptedId(
          await upload(owner.token, { content: CONTENT, name: 'once-more.csv' }).query({ force: 'true' }).expect(202),
        );
        expect(await finished(againId)).toBe('completed');
        const rows = await prisma.import.findMany({
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { id: true, contentSha256: true, forced: true },
        });
        expect(rows).toEqual([
          { id: existingImportId, contentSha256: sha256(CONTENT), forced: false },
          { id: forcedId, contentSha256: sha256(CONTENT), forced: true },
          { id: againId, contentSha256: sha256(CONTENT), forced: true },
        ]);
        const third = await upload(owner.token, { content: CONTENT, name: 'third.csv' }).query({ force: 'false' }).expect(409);
        expect(third.body).toMatchObject({ code: 'DUPLICATE_IMPORT', existingImportId: againId });
      });

      it('accepts exactly one of several identical uploads sent at once', async () => {
        const owner = await seedUser();

        const responses = await Promise.all(
          Array.from({ length: 4 }, (_, index) =>
            upload(owner.token, { content: CONTENT, name: `same-${index}.csv` }).then((response) => response),
          ),
        );

        const [accepted, ...others] = responses.filter((response) => response.status === 202);
        const rejected = responses.filter((response) => response.status === 409);
        expect(others).toHaveLength(0);
        expect(rejected).toHaveLength(3);
        if (accepted === undefined) {
          throw new Error('No upload was accepted');
        }
        const importId = acceptedId(accepted);
        for (const response of rejected) {
          expect(response.body).toEqual({
            statusCode: 409,
            code: 'DUPLICATE_IMPORT',
            message: 'This file was already imported',
            existingImportId: importId,
          });
        }
        expect(await finished(importId)).toBe('completed');
        expect(await prisma.import.count()).toBe(1);
        expect(await prisma.import.count({ where: { contentSha256: sha256(CONTENT), forced: false } })).toBe(1);
        expect(await prisma.exchangeRateSnapshot.count()).toBe(1);
        expect(await uploadedFiles()).toEqual([]);
      });

      it('rejects the same content uploaded by another user', async () => {
        const owner = await seedUser();
        const other = await seedUser();
        const existingImportId = await importFile(owner.token, { content: CONTENT, name: 'first.csv' });

        const response = await upload(other.token, { content: CONTENT, name: 'mine.csv' }).expect(409);

        expect(response.body).toMatchObject({ code: 'DUPLICATE_IMPORT', existingImportId });
        expect(await uploadedFiles()).toEqual([]);
      });

      it.each<[ImportStatus, number]>([
        ['pending', 409],
        ['processing', 409],
        ['completed', 409],
        ['failed', 202],
      ])('answers an upload matching a %s import with %i', async (status, expected) => {
        const owner = await seedUser();
        const existingImportId = await seedImport(owner.id, { status, contentSha256: sha256(CONTENT) });

        const response = await upload(owner.token, { content: CONTENT, name: 'retry.csv' }).expect(expected);

        if (expected === 409) {
          expect(response.body).toMatchObject({ code: 'DUPLICATE_IMPORT', existingImportId });
          expect(await prisma.import.count()).toBe(1);
        } else {
          expect(await finished(acceptedId(response))).toBe('completed');
          expect(await prisma.import.count()).toBe(2);
        }
      });

      it('accepts a file that differs by a single byte', async () => {
        const owner = await seedUser();
        await importFile(owner.token, { content: CONTENT, name: 'first.csv' });
        const changed = CONTENT.replace('SKU-1;', 'SKU-2;');

        const importId = acceptedId(await upload(owner.token, { content: changed, name: 'first.csv' }).expect(202));

        expect(await finished(importId)).toBe('completed');
        expect(changed.length).toBe(CONTENT.length);
      });
    });
  });

  describe('processing', () => {
    it('retries a failed attempt and ends with counters from a single pass', async () => {
      const user = await seedUser();
      storage.failuresLeft = 1;

      const importId = acceptedId(await upload(user.token, { content: csvRows(1200), name: 'products.csv' }).expect(202));

      expect(await finished(importId)).toBe('completed');
      const row = await prisma.import.findUniqueOrThrow({
        where: { id: importId },
        select: { totalRows: true, processedRows: true, failureReason: true },
      });
      expect(row).toEqual({ totalRows: 1200, processedRows: 1200, failureReason: null });
      const job = await queue.getJob(importId);
      expect(job?.attemptsMade).toBe(2);
      expect(await job?.getState()).toBe('completed');
      expect(await uploadedFiles()).toEqual([]);
    });

    it('marks the import failed only after the last attempt fails', async () => {
      const user = await seedUser();
      storage.failuresLeft = Number.POSITIVE_INFINITY;
      const intermediate: Array<Promise<ImportStatus | undefined>> = [];
      const onFailed = (job: Job | undefined): void => {
        if (job?.id !== undefined && job.attemptsMade < JOB_ATTEMPTS) {
          intermediate.push(statusOf(job.id));
        }
      };
      processor.worker.on('failed', onFailed);

      try {
        const importId = acceptedId(await upload(user.token, { content: csvRows(10), name: 'products.csv' }).expect(202));

        expect(await finished(importId)).toBe('failed');
        expect(await Promise.all(intermediate)).toEqual(['processing', 'processing']);
        const row = await prisma.import.findUniqueOrThrow({
          where: { id: importId },
          select: { failureReason: true },
        });
        expect(row.failureReason).toBe('Simulated read failure');
        const job = await queue.getJob(importId);
        expect(job?.attemptsMade).toBe(JOB_ATTEMPTS);
        expect(await job?.getState()).toBe('failed');
        expect(await waitFor(uploadedFiles, (files) => files.length === 0)).toEqual([]);
      } finally {
        processor.worker.off('failed', onFailed);
      }
    });

    it.each<[ImportStatus]>([['completed'], ['failed']])(
      'ignores a redelivered job for an import already %s',
      async (status) => {
        const user = await seedUser();
        const importId = await seedImport(user.id, { status, totalRows: 7, processedRows: 7 });
        const before = await prisma.import.findUniqueOrThrow({ where: { id: importId } });

        await app.get(ImportProcessingService).run({ importId, filePath: join(uploadDir, 'missing.csv') });

        expect(await prisma.import.findUniqueOrThrow({ where: { id: importId } })).toEqual(before);
      },
    );
  });

  describe('reconciliation', () => {
    it('keeps an import pending when enqueueing fails and lets reconciliation enqueue and complete it', async () => {
      const user = await seedUser();
      importQueue.enqueueFailuresLeft = 1;

      const importId = acceptedId(await upload(user.token, { content: csvRows(3), name: 'products.csv' }).expect(202));

      expect(await failureOf(importId)).toEqual({ status: 'pending', failureReason: null });
      expect(await queue.getJob(importId)).toBeUndefined();
      expect(await uploadedFiles()).toHaveLength(1);

      expect(await reconcileLater()).toEqual({ ...NOTHING_RECOVERED, requeued: 1 });

      expect((await queue.getJob(importId))?.id).toBe(importId);
      expect(await finished(importId)).toBe('completed');
      const row = await prisma.import.findUniqueOrThrow({ where: { id: importId }, select: { totalRows: true } });
      expect(row.totalRows).toBe(3);
      expect(await uploadedFiles()).toEqual([]);
    });

    it('fails an import left pending before its exchange rates were captured and removes its file', async () => {
      const user = await seedUser();
      const importId = await seedStaleImport(user.id, { filePath: await storedFile(csvRows(2)) }, false);

      expect(await reconcileLater()).toEqual({ ...NOTHING_RECOVERED, interrupted: 1 });

      expect(await failureOf(importId)).toEqual({ status: 'failed', failureReason: IMPORT_INTERRUPTED_REASON });
      expect(await queue.getJob(importId)).toBeUndefined();
      expect(await uploadedFiles()).toEqual([]);
    });

    it.each<[string, ImportStatus]>([
      ['left pending by a crash between the snapshot and the enqueue', 'pending'],
      ['processing without a job', 'processing'],
    ])('requeues an import %s under its own id and completes it', async (_label, status) => {
      const user = await seedUser();
      const importId = await seedStaleImport(user.id, { status, filePath: await storedFile(csvRows(2)) }, true);

      expect(await reconcileLater()).toEqual({ ...NOTHING_RECOVERED, requeued: 1 });

      const job = await queue.getJob(importId);
      expect(job?.id).toBe(importId);
      expect(job?.data).toEqual({ importId, filePath: expect.stringContaining(uploadDir) as string });
      expect(await finished(importId)).toBe('completed');
      const row = await prisma.import.findUniqueOrThrow({ where: { id: importId }, select: { totalRows: true } });
      expect(row.totalRows).toBe(2);
      expect(await uploadedFiles()).toEqual([]);
    });

    it('replaces a finished job retained under the same id when requeueing', async () => {
      const user = await seedUser();
      const importId = await importFile(user.token, { content: csvRows(2), name: 'products.csv' });
      const finishedJob = await queue.getJob(importId);
      expect(await finishedJob?.getState()).toBe('completed');
      const { filePath } = await prisma.import.findUniqueOrThrow({ where: { id: importId }, select: { filePath: true } });
      if (filePath === null) {
        throw new Error('Import without a stored file path');
      }
      await writeFile(filePath, csvRows(5));
      await prisma.import.update({ where: { id: importId }, data: { status: 'processing' }, select: { id: true } });

      expect(await reconcileLater()).toEqual({ ...NOTHING_RECOVERED, requeued: 1 });

      expect(await finished(importId)).toBe('completed');
      const requeued = await queue.getJob(importId);
      expect(requeued?.timestamp).toBeGreaterThan(finishedJob?.timestamp ?? Number.POSITIVE_INFINITY);
      const row = await prisma.import.findUniqueOrThrow({ where: { id: importId }, select: { totalRows: true } });
      expect(row.totalRows).toBe(5);
    });

    it('leaves an import whose job is still queued untouched', async () => {
      const user = await seedUser();
      const filePath = await storedFile(csvRows(2));
      const importId = await seedStaleImport(user.id, { filePath }, true);
      await queue.add(IMPORT_JOB_NAME, { importId, filePath }, { jobId: importId, delay: 60000 });

      expect(await reconcileLater()).toEqual(NOTHING_RECOVERED);

      expect(await failureOf(importId)).toEqual({ status: 'pending', failureReason: null });
      expect(await (await queue.getJob(importId))?.getState()).toBe('delayed');
      expect(await uploadedFiles()).toHaveLength(1);
    });

    it.each<[string, (dir: string) => string | null]>([
      ['its stored file was deleted', (dir) => join(dir, `${randomUUID()}.csv`)],
      ['it has no stored file path', () => null],
    ])('fails an import with a snapshot when %s', async (_label, pathIn) => {
      const user = await seedUser();
      const importId = await seedStaleImport(user.id, { filePath: pathIn(uploadDir) }, true);

      expect(await reconcileLater()).toEqual({ ...NOTHING_RECOVERED, fileMissing: 1 });

      expect(await failureOf(importId)).toEqual({ status: 'failed', failureReason: IMPORT_FILE_MISSING_REASON });
      expect(await queue.getJob(importId)).toBeUndefined();
    });

    it('ignores imports updated within the reconciliation delay', async () => {
      const user = await seedUser();
      const withoutSnapshot = await seedStaleImport(user.id, { filePath: await storedFile(csvRows(1)) }, false);
      const withSnapshot = await seedStaleImport(user.id, { filePath: await storedFile(csvRows(2)) }, true);

      expect(await app.get(ImportRecoveryService).reconcile(new Date())).toEqual(NOTHING_RECOVERED);

      expect(await failureOf(withoutSnapshot)).toEqual({ status: 'pending', failureReason: null });
      expect(await failureOf(withSnapshot)).toEqual({ status: 'pending', failureReason: null });
      expect(await queue.count()).toBe(0);
      expect(await uploadedFiles()).toHaveLength(2);
    });
  });

  describe('access', () => {
    it.each<[string, () => request.Test]>([
      ['upload', () => upload(undefined, { content: csvRows(1), name: 'products.csv' })],
      ['lookup', () => getImport(randomUUID())],
    ])('requires a token for %s', async (_label, send) => {
      await send().expect(401);

      expect(await prisma.import.count()).toBe(0);
      expect(await uploadedFiles()).toEqual([]);
    });

    it.each<[string, (token: string, importId: string) => request.Test]>([
      ['upload', (token) => upload(token, { content: csvRows(1), name: 'products.csv' })],
      ['lookup', (token, importId) => getImport(importId, token)],
    ])('denies %s to a custom role holding every permission except imports:manage', async (_label, send) => {
      const owner = await seedUser();
      const importId = await seedImport(owner.id);
      const denied = await seedUser(PERMISSIONS.filter((permission) => permission !== 'imports:manage'));
      const viewer = await seedUserWithRole(viewerRoleId);

      const asCustom = await send(denied.token, importId).expect(403);
      await send(viewer.token, importId).expect(403);

      expect(asCustom.body).toMatchObject({ statusCode: 403, code: 'ACCESS_DENIED' });
      expect(await prisma.import.count()).toBe(1);
      expect(await queue.count()).toBe(0);
      expect(await uploadedFiles()).toEqual([]);
    });

    it('shows an import to any user holding imports:manage, not only its creator', async () => {
      const owner = await seedUser();
      const other = await seedUser();
      const importId = await seedImport(owner.id);

      const asOwner = await getImport(importId, owner.token).expect(200);
      const asOther = await getImport(importId, other.token).expect(200);

      expect(asOwner.body).toMatchObject({ id: importId, status: 'pending', totalRows: null, rates: null });
      expect(asOther.body).toEqual(asOwner.body);
    });
  });

  describe('status lookup', () => {
    it('answers 404 for an unknown id and 400 for a malformed one', async () => {
      const user = await seedUser();

      const unknown = await getImport(randomUUID(), user.token).expect(404);
      await getImport('not-a-uuid', user.token).expect(400);

      expect(unknown.body).toEqual({ statusCode: 404, code: 'IMPORT_NOT_FOUND', message: 'Import not found' });
    });

    it('returns the stored counters, rejections by reason and failure reason', async () => {
      const owner = await seedUser();
      const importId = await seedImport(owner.id, {
        status: 'failed',
        totalRows: 10,
        processedRows: 6,
        acceptedRows: 3,
        rejectedRows: 3,
        rejectedByReason: { INVALID_MONEY: 2, INVALID_DATE: 1 },
        failureReason: 'Worker crashed',
      });

      const response = await getImport(importId, owner.token).expect(200);

      expect(importDetailSchema.parse(response.body)).toMatchObject({
        status: 'failed',
        totalRows: 10,
        processedRows: 6,
        acceptedRows: 3,
        rejectedRows: 3,
        rejectedByReason: { INVALID_MONEY: 2, INVALID_DATE: 1 },
        failureReason: 'Worker crashed',
        rates: null,
      });
    });
  });

  it('documents both import routes with their error responses in the OpenAPI document', async () => {
    const response = await request(app.getHttpServer()).get(`/${DOCS_PATH}-json`).expect(200);
    const document = response.body as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> } | undefined>>;
    };

    expect(Object.keys(document.paths['/imports']?.post?.responses ?? {})).toEqual(
      expect.arrayContaining(['202', '400', '401', '403', '409', '413', '503']),
    );
    expect(Object.keys(document.paths['/imports/{id}']?.get?.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '400', '401', '403', '404']),
    );
  });
});
