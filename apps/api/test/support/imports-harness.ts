import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { ImportStatus, loginResponseSchema } from '@stockpile/shared';
import { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { AppConfigService } from '../../src/infra/config/app-config.service';
import { PrismaService } from '../../src/infra/prisma/prisma.service';
import { PASSWORD_HASHER, PasswordHasher } from '../../src/modules/auth/ports/password-hasher.port';
import { EXCHANGE_RATES_PROVIDER, ExchangeRatesProvider, LatestRates } from '../../src/modules/exchange-rates/ports/exchange-rates.provider';
import { IMPORTS_QUEUE } from '../../src/modules/imports/adapters/queue/imports-queue.constants';
import { ImportsWorkerModule } from '../../src/modules/imports/imports-worker.module';
import { ImportJobPayload } from '../../src/modules/imports/ports/import-queue';
import { ADMIN_ROLE_NAME, seedRoles } from '../../src/seed/admin-seed';

const PASSWORD = 'importer-password-0123';
const TERMINAL_STATUSES: ReadonlySet<ImportStatus> = new Set<ImportStatus>(['completed', 'failed']);
const DEFAULT_TERMINAL_TIMEOUT_MS = 15000;
const POLL_INTERVAL_MS = 20;

export interface UploadFile {
  content: string | Buffer;
  name: string;
}

export interface SeededUser {
  id: string;
  email: string;
  token: string;
}

export interface SeededRoles {
  adminRoleId: string;
  viewerRoleId: string;
}

export interface ImportsHarnessOptions {
  redisDb: number;
  env?: Readonly<Record<string, string>>;
  rates?: ExchangeRatesProvider;
  override?: (builder: TestingModuleBuilder, uploadDir: string) => TestingModuleBuilder;
}

class FixedRatesProvider implements ExchangeRatesProvider {
  constructor(private readonly currencies: readonly string[]) {}

  fetchLatest(): Promise<LatestRates> {
    return Promise.resolve({
      date: '2026-03-04',
      rates: Object.fromEntries(this.currencies.map((code, index) => [code, index + 1.5])),
      source: 'fixed.example.test',
    });
  }
}

export async function waitFor<T>(probe: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = DEFAULT_TERMINAL_TIMEOUT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (accept(value)) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Condition not met in ${timeoutMs}ms, last value: ${JSON.stringify(value)}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

export function acceptedImportId(response: request.Response): string {
  const body = response.body as { importId: string };
  expect(Object.keys(body)).toEqual(['importId']);
  return body.importId;
}

export class ImportsHarness {
  private constructor(
    readonly app: INestApplication<App>,
    readonly prisma: PrismaService,
    readonly queue: Queue<ImportJobPayload>,
    readonly uploadDir: string,
    private readonly passwordHash: string,
  ) {}

  static async start(options: ImportsHarnessOptions): Promise<ImportsHarness> {
    const uploadDir = await mkdtemp(join(tmpdir(), 'stockpile-imports-test-'));
    const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
    redisUrl.pathname = `/${options.redisDb}`;
    Object.assign(process.env, { REDIS_URL: redisUrl.toString(), UPLOAD_DIR: uploadDir }, options.env);

    const base = Test.createTestingModule({ imports: [AppModule, ImportsWorkerModule] });
    const withRates = options.rates
      ? base.overrideProvider(EXCHANGE_RATES_PROVIDER).useValue(options.rates)
      : base.overrideProvider(EXCHANGE_RATES_PROVIDER).useFactory({
          inject: [AppConfigService],
          factory: (config: AppConfigService): ExchangeRatesProvider => new FixedRatesProvider(config.get('EXCHANGE_CURRENCIES')),
        });
    const builder = options.override ? options.override(withRates, uploadDir) : withRates;
    const moduleRef = await builder.compile();
    const app = moduleRef.createNestApplication<INestApplication<App>>();
    configureApp(app);
    await app.init();
    const passwordHash = await app.get<PasswordHasher>(PASSWORD_HASHER).hash(PASSWORD);

    return new ImportsHarness(
      app,
      app.get(PrismaService),
      app.get<Queue<ImportJobPayload>>(getQueueToken(IMPORTS_QUEUE)),
      uploadDir,
      passwordHash,
    );
  }

  async reset(): Promise<SeededRoles> {
    await this.queue.obliterate({ force: true });
    await this.prisma.import.deleteMany();
    await this.prisma.user.deleteMany();
    await this.prisma.role.deleteMany();
    const roles = await seedRoles(this.prisma);
    await rm(this.uploadDir, { recursive: true, force: true });
    await mkdir(this.uploadDir, { recursive: true });
    return roles;
  }

  async login(roleId: string): Promise<SeededUser> {
    const user = await this.prisma.user.create({
      data: { name: 'Importer', email: `${randomUUID()}@example.test`, passwordHash: this.passwordHash, status: 'ACTIVE', roleId },
      select: { id: true, email: true },
    });
    const response = await request(this.app.getHttpServer()).post('/auth/login').send({ email: user.email, password: PASSWORD }).expect(200);
    return { ...user, token: loginResponseSchema.parse(response.body).accessToken };
  }

  async loginAdmin(): Promise<SeededUser> {
    const admin = await this.prisma.role.findUniqueOrThrow({ where: { name: ADMIN_ROLE_NAME }, select: { id: true } });
    return this.login(admin.id);
  }

  upload(token: string | undefined, file?: UploadFile | string): request.Test {
    const pending = request(this.app.getHttpServer()).post('/imports');
    const authed = token === undefined ? pending : pending.auth(token, { type: 'bearer' });
    if (file === undefined) {
      return authed.field('note', 'no file here');
    }
    return typeof file === 'string' ? authed.attach('file', file) : authed.attach('file', Buffer.from(file.content), file.name);
  }

  getImport(id: string, token?: string): request.Test {
    const pending = request(this.app.getHttpServer()).get(`/imports/${id}`);
    return token === undefined ? pending : pending.auth(token, { type: 'bearer' });
  }

  async statusOf(importId: string): Promise<ImportStatus | undefined> {
    const row = await this.prisma.import.findUnique({ where: { id: importId }, select: { status: true } });
    return row?.status;
  }

  waitForTerminal(importId: string, timeoutMs = DEFAULT_TERMINAL_TIMEOUT_MS): Promise<ImportStatus | undefined> {
    return waitFor(
      () => this.statusOf(importId),
      (status) => status !== undefined && TERMINAL_STATUSES.has(status),
      timeoutMs,
    );
  }

  async importFile(token: string, file: UploadFile, timeoutMs = DEFAULT_TERMINAL_TIMEOUT_MS): Promise<string> {
    const importId = acceptedImportId(await this.upload(token, file).expect(202));
    expect(await this.waitForTerminal(importId, timeoutMs)).toBe('completed');
    return importId;
  }

  readonly uploadedFiles = (): Promise<string[]> => readdir(this.uploadDir).catch((): string[] => []);

  async close(): Promise<void> {
    await this.queue.obliterate({ force: true });
    await this.prisma.import.deleteMany();
    await this.prisma.user.deleteMany();
    await this.app.close();
    await rm(this.uploadDir, { recursive: true, force: true });
  }
}
