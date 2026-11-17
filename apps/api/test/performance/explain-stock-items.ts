import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { SortOrder, StockItemSort, STOCK_ITEM_SORTS, stockItemsQuerySchema } from '@stockpile/shared';
import { z } from 'zod';
import { AppConfigModule } from '../../src/infra/config/config.module';
import { AppConfigService } from '../../src/infra/config/app-config.service';
import { toDbDate } from '../../src/infra/dates/calendar-date';
import { ListingService } from '../../src/infra/listing/listing';
import { encodeListingCursor } from '../../src/infra/listing/listing-cursor';
import { LoggerModule } from '../../src/infra/logger/logger.module';
import { PrismaService } from '../../src/infra/prisma/prisma.service';
import { PrismaImportCatalogRepository } from '../../src/modules/imports/adapters/persistence/prisma-import-catalog.repository';
import { LocalFileStorage } from '../../src/modules/imports/adapters/storage/local-file-storage';
import { ImportProcessingService } from '../../src/modules/imports/application/import-processing.service';
import { FILE_STORAGE, FileStorage } from '../../src/modules/imports/ports/file-storage';
import { IMPORT_CATALOG_REPOSITORY, ImportCatalogRepository } from '../../src/modules/imports/ports/import-catalog';
import { STOCK_ITEMS_LISTING, StockItemsService } from '../../src/modules/stock-items/application/stock-items.service';
import { seedRoles } from '../../src/seed/admin-seed';
import { loadTestEnv } from '../support/test-env';

const SCHEMA = 'explain_stock_items';
const API_ROOT = resolve(__dirname, '../..');
const REPO_ROOT = resolve(API_ROOT, '../..');
const REPORT_PATH = join(tmpdir(), 'stockpile-explain-stock-items.json');
const WARMUP_RUNS = 3;
const RATES = { EUR: 0.9213, GBP: 0.7891, JPY: 151.37, BRL: 5.0123 };

const settingsSchema = z.object({
  EXPLAIN_ROWS: z.coerce.number().int().positive().default(200_000),
  EXPLAIN_OTHER_ROWS: z.coerce.number().int().nonnegative().default(50_000),
  EXPLAIN_SEED: z.coerce.number().int().nonnegative().default(20261117),
  EXPLAIN_RUNS: z.coerce.number().int().min(20).default(30),
  EXPLAIN_P95_TARGET_MS: z.coerce.number().positive().default(100),
  EXPLAIN_KEEP_SCHEMA: z.stringbool().default(false),
});

type Settings = z.infer<typeof settingsSchema>;

const manifestSchema = z.object({
  total: z.number().int(),
  accepted: z.number().int(),
  rejected: z.number().int(),
  expectedCreated: z.number().int(),
});

type Manifest = z.infer<typeof manifestSchema>;

const preparedStatementsSchema = z.array(z.object({ statement: z.string(), types: z.array(z.string()) }));

const queryPlanRowsSchema = z.array(
  z.object({ 'QUERY PLAN': z.array(z.object({ Plan: z.unknown(), 'Execution Time': z.number() })) }),
);

const anchorRowSchema = z.object({
  id: z.number().int(),
  importId: z.string(),
  sku: z.string(),
  name: z.string(),
  category: z.string(),
  brand: z.string().nullable(),
  supplier: z.string(),
  country: z.string(),
  warehouse: z.string(),
  lot: z.string(),
  quantity: z.number().int(),
  unitCostCents: z.number().int(),
  unitPriceCents: z.number().int(),
  expiration: z.date().nullable(),
});

const countRowsSchema = z.array(z.object({ total: z.number().int() }));

const valueRowsSchema = z.array(z.object({ value: z.string() }));

type ScopeName = 'catalog' | 'import';
type PageName = 'first' | 'cursor';

interface Case {
  name: string;
  scope: ScopeName;
  sort: StockItemSort;
  order: SortOrder;
  page: PageName;
  principal: boolean;
  params: Record<string, string | string[]>;
}

interface CapturedQuery {
  query: string;
  params: string;
}

interface ExplainedQuery {
  sql: string;
  params: unknown[];
  seqScan: boolean;
  access: string[];
  executionMs: number;
}

interface CaseResult {
  case: Case;
  items: number;
  total: number | null;
  seqScan: boolean;
  explainMs: number;
  p95Ms: number;
  queries: ExplainedQuery[];
}

interface Fixture {
  mainImportId: string;
  categories: string[];
  warehouses: string[];
  commonTerm: string;
  rareTerm: string;
  moneyTerm: string;
}

function prismaCli(args: string[]): void {
  const cli = require.resolve('prisma/build/index.js', { paths: [API_ROOT] });
  execFileSync(process.execPath, [cli, ...args], { cwd: API_ROOT, env: process.env, stdio: 'pipe' });
}

async function generateDataset(directory: string, rows: number, seed: number): Promise<{ path: string; manifest: Manifest }> {
  const path = join(directory, `inventory-${rows}-${seed}.csv`);
  const cli = require.resolve('tsx/cli', { paths: [REPO_ROOT] });
  execFileSync(
    process.execPath,
    [cli, 'scripts/generate-dataset.ts', '--rows', String(rows), '--seed', String(seed), '--out', path],
    { cwd: REPO_ROOT, stdio: 'pipe' },
  );
  const manifestFile = `${path.slice(0, -'.csv'.length)}.manifest.json`;
  const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestFile, 'utf8')));
  return { path, manifest };
}

async function importProcessing(uploadDir: string): Promise<{ service: ImportProcessingService; close: () => Promise<void> }> {
  await mkdir(uploadDir, { recursive: true });
  const moduleRef = await Test.createTestingModule({
    imports: [AppConfigModule, LoggerModule],
    providers: [
      {
        provide: PrismaService,
        inject: [AppConfigService],
        useFactory: (config: AppConfigService): PrismaService => new PrismaService(config),
      },
      { provide: FILE_STORAGE, useValue: new LocalFileStorage(uploadDir) },
      {
        provide: IMPORT_CATALOG_REPOSITORY,
        inject: [PrismaService],
        useFactory: (prisma: PrismaService): ImportCatalogRepository => new PrismaImportCatalogRepository(prisma),
      },
      {
        provide: ImportProcessingService,
        inject: [PrismaService, AppConfigService, FILE_STORAGE, IMPORT_CATALOG_REPOSITORY, PinoLogger],
        useFactory: (
          prisma: PrismaService,
          config: AppConfigService,
          storage: FileStorage,
          catalog: ImportCatalogRepository,
          logger: PinoLogger,
        ): ImportProcessingService => new ImportProcessingService(prisma, config, storage, catalog, logger),
      },
    ],
  }).compile();
  await moduleRef.init();
  return { service: moduleRef.get(ImportProcessingService), close: () => moduleRef.close() };
}

async function runImport(
  client: PrismaClient,
  processing: ImportProcessingService,
  uploadDir: string,
  createdById: string,
  dataset: { path: string; manifest: Manifest },
  expectCreated: boolean,
): Promise<string> {
  const filePath = join(uploadDir, `${Date.now()}-${dataset.manifest.total}.csv`);
  await copyFile(dataset.path, filePath);
  const created = await client.import.create({
    data: { fileName: dataset.path, filePath, createdById },
    select: { id: true },
  });
  await client.exchangeRateSnapshot.create({
    data: {
      importId: created.id,
      base: 'USD',
      rateDate: toDbDate('2026-11-17'),
      fetchedAt: new Date(),
      source: 'explain',
      rates: RATES,
    },
    select: { id: true },
  });

  await processing.run({ importId: created.id, filePath });

  const result = await client.import.findUniqueOrThrow({
    where: { id: created.id },
    select: { status: true, totalRows: true, acceptedRows: true, rejectedRows: true, itemsCreated: true },
  });
  const { manifest } = dataset;
  if (
    result.status !== 'completed' ||
    result.totalRows !== manifest.total ||
    result.acceptedRows !== manifest.accepted ||
    result.rejectedRows !== manifest.rejected ||
    (expectCreated && result.itemsCreated !== manifest.expectedCreated)
  ) {
    throw new Error(`Import ${created.id} diverges from manifest: ${JSON.stringify({ result, manifest })}`);
  }
  return created.id;
}

async function topValues(client: PrismaClient, column: 'category' | 'warehouse'): Promise<string[]> {
  const identifier = Prisma.raw(column);
  return valueRowsSchema
    .parse(
      await client.$queryRaw`SELECT ${identifier} AS value FROM stock_items GROUP BY ${identifier} ORDER BY count(*) DESC, ${identifier} LIMIT 2`,
    )
    .map((row) => row.value);
}

async function searchTerms(client: PrismaClient): Promise<Pick<Fixture, 'commonTerm' | 'rareTerm' | 'moneyTerm'>> {
  const [common] = valueRowsSchema.parse(
    await client.$queryRaw`SELECT lower(split_part(name, ' ', 1)) AS value FROM stock_items GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 1`,
  );
  const [rare] = valueRowsSchema.parse(
    await client.$queryRaw`SELECT sku AS value FROM stock_items ORDER BY id OFFSET (SELECT count(*) / 2 FROM stock_items) LIMIT 1`,
  );
  const [money] = valueRowsSchema.parse(
    await client.$queryRaw`SELECT to_char(unit_price_cents / 100.0, 'FM999999990.00') AS value FROM stock_items ORDER BY id LIMIT 1`,
  );
  if (!common || !rare || !money) {
    throw new Error('Fixture is empty');
  }
  return { commonTerm: common.value.slice(0, 4), rareTerm: rare.value, moneyTerm: money.value };
}

async function seed(client: PrismaClient, settings: Settings, workDir: string): Promise<Fixture> {
  const roles = await seedRoles(client);
  const user = await client.user.create({
    data: { name: 'Explain', email: 'explain@example.test', passwordHash: 'unused', status: 'ACTIVE', roleId: roles.adminRoleId },
    select: { id: true },
  });

  const main = await generateDataset(workDir, settings.EXPLAIN_ROWS, settings.EXPLAIN_SEED);
  const other =
    settings.EXPLAIN_OTHER_ROWS > 0 ? await generateDataset(workDir, settings.EXPLAIN_OTHER_ROWS, settings.EXPLAIN_SEED + 1) : null;

  const uploadDir = join(workDir, 'uploads');
  const processing = await importProcessing(uploadDir);
  try {
    const started = performance.now();
    const mainImportId = await runImport(client, processing.service, uploadDir, user.id, main, true);
    const mainMs = performance.now() - started;
    if (other !== null) {
      await runImport(client, processing.service, uploadDir, user.id, other, false);
    }
    process.stdout.write(
      `Imported ${main.manifest.total} rows (accepted ${main.manifest.accepted}, created ${main.manifest.expectedCreated}) in ${Math.round(mainMs)} ms` +
        (other === null ? '' : ` + ${other.manifest.total} rows`) +
        ` through ImportProcessingService (schema ${SCHEMA})\n`,
    );
    const items = await client.stockItem.count();
    process.stdout.write(`stock_items: ${items} rows\n`);
    return {
      mainImportId,
      categories: await topValues(client, 'category'),
      warehouses: await topValues(client, 'warehouse'),
      ...(await searchTerms(client)),
    };
  } finally {
    await processing.close();
  }
}

function cases(fixture: Fixture): Case[] {
  const result: Case[] = [];
  const scopes: ScopeName[] = ['catalog', 'import'];
  const orders: SortOrder[] = ['asc', 'desc'];
  const pages: PageName[] = ['first', 'cursor'];

  for (const scope of scopes) {
    for (const sort of STOCK_ITEM_SORTS) {
      for (const order of orders) {
        for (const page of pages) {
          result.push({ name: 'sort', scope, sort, order, page, principal: true, params: {} });
        }
      }
    }

    const filtered: Array<{ name: string; principal: boolean; params: Record<string, string | string[]>; sorts: StockItemSort[] }> = [
      {
        name: 'multi-filter',
        principal: true,
        params: { category: fixture.categories, warehouse: fixture.warehouses },
        sorts: ['sku', 'unitPrice'],
      },
      { name: 'q-rare', principal: true, params: { q: fixture.rareTerm }, sorts: ['sku', 'name'] },
      { name: 'q-money', principal: true, params: { q: fixture.moneyTerm }, sorts: ['sku'] },
      { name: 'q-common', principal: false, params: { q: fixture.commonTerm }, sorts: ['sku', 'name'] },
    ];
    for (const entry of filtered) {
      for (const sort of entry.sorts) {
        for (const page of pages) {
          result.push({ name: entry.name, scope, sort, order: 'asc', page, principal: entry.principal, params: entry.params });
        }
      }
    }
  }

  return result;
}

function sqlLiteral(value: unknown): string {
  if (value === null) {
    return 'NULL';
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'string') {
    return `'${value.replaceAll("'", "''")}'`;
  }
  throw new Error(`Unsupported parameter ${JSON.stringify(value)}`);
}

function collectNodes(node: unknown, found: { access: string[]; seqScan: boolean }): void {
  if (typeof node !== 'object' || node === null) {
    return;
  }
  const type: unknown = Reflect.get(node, 'Node Type');
  const relation: unknown = Reflect.get(node, 'Relation Name');
  const index: unknown = Reflect.get(node, 'Index Name');
  if (typeof type === 'string' && (relation === 'stock_items' || (typeof index === 'string' && index.startsWith('stock_items')))) {
    found.access.push(typeof index === 'string' ? `${type}(${index})` : type);
    if (type === 'Seq Scan') {
      found.seqScan = true;
    }
  }
  const children: unknown = Reflect.get(node, 'Plans');
  if (Array.isArray(children)) {
    for (const child of children) {
      collectNodes(child, found);
    }
  }
}

async function boundTypes(client: PrismaClient, statement: string): Promise<string[]> {
  const rows = preparedStatementsSchema.parse(
    await client.$queryRaw`SELECT statement, parameter_types::text[] AS types FROM pg_prepared_statements WHERE statement = ${statement}`,
  );
  const [row] = rows;
  if (!row) {
    throw new Error(`Prisma did not prepare ${statement}`);
  }
  return row.types;
}

async function explain(client: PrismaClient, captured: CapturedQuery): Promise<ExplainedQuery> {
  const params = z.array(z.unknown()).parse(JSON.parse(captured.params));
  const types = await boundTypes(client, captured.query);
  const signature = types.length > 0 ? `(${types.join(', ')})` : '';
  const execute =
    params.length > 0 ? `EXECUTE explain_stock_items_q(${params.map(sqlLiteral).join(', ')})` : 'EXECUTE explain_stock_items_q';
  const rows = await client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`PREPARE explain_stock_items_q${signature} AS ${captured.query}`);
    const plan = await tx.$queryRawUnsafe<unknown>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${execute}`);
    await tx.$executeRawUnsafe('DEALLOCATE explain_stock_items_q');
    return plan;
  });
  const [result] = queryPlanRowsSchema.parse(rows);
  const [plan] = result?.['QUERY PLAN'] ?? [];
  if (!plan) {
    throw new Error(`No plan for ${captured.query}`);
  }
  const found = { access: [] as string[], seqScan: false };
  collectNodes(plan.Plan, found);
  return { sql: captured.query, params, seqScan: found.seqScan, access: found.access, executionMs: plan['Execution Time'] };
}

async function stockItemsService(client: PrismaClient): Promise<StockItemsService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      ListingService,
      { provide: AppConfigService, useValue: new AppConfigService() },
      { provide: PrismaService, useValue: client },
      {
        provide: StockItemsService,
        inject: [PrismaService, ListingService, AppConfigService],
        useFactory: (prisma: PrismaService, listing: ListingService, config: AppConfigService): StockItemsService =>
          new StockItemsService(prisma, listing, config),
      },
    ],
  }).compile();
  return moduleRef.get(StockItemsService);
}

async function middleCursor(client: PrismaClient, service: StockItemsService, listing: ListingService, test: Case, fixture: Fixture): Promise<string> {
  const query = stockItemsQuerySchema.parse(queryParams(test, fixture, undefined));
  const { scope } = await service.prepare(query);
  const page = await listing.page(
    STOCK_ITEMS_LISTING,
    { ...query, limit: 1 },
    scope,
    {
      findMany: async ({ where, orderBy }) => {
        const counted = countRowsSchema.parse(await client.$queryRaw`SELECT count(*)::int AS total FROM stock_items WHERE ${where}`);
        const offset = Math.floor((counted[0]?.total ?? 0) / 2);
        const rows = await client.$queryRaw<unknown[]>`
          SELECT id, import_id AS "importId", sku, name, category, brand, supplier, country, warehouse, lot, quantity,
            unit_cost_cents AS "unitCostCents", unit_price_cents AS "unitPriceCents", expiration
          FROM stock_items
          WHERE ${where}
          ORDER BY ${Prisma.join(orderBy)}
          OFFSET ${offset}
          LIMIT 1
        `;
        return rows.map((row) => anchorRowSchema.parse(row));
      },
    },
    null,
  );
  const [anchor] = page.rows;
  if (!anchor) {
    throw new Error(`No anchor for ${label(test)}`);
  }
  return encodeListingCursor({ sort: test.sort, order: test.order, id: anchor.id });
}

function queryParams(test: Case, fixture: Fixture, cursor: string | undefined): Record<string, unknown> {
  return {
    ...test.params,
    importId: test.scope === 'import' ? fixture.mainImportId : undefined,
    sort: test.sort,
    order: test.order,
    cursor,
  };
}

function label(test: Case): string {
  return `${test.scope} ${test.name} ${test.sort}/${test.order} ${test.page}`;
}

function percentile(samples: number[], ratio: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(ratio * sorted.length) - 1)] ?? 0;
}

function formatRow(result: CaseResult): string {
  const { case: test } = result;
  const access = result.queries.map((entry) => entry.access.join('+')).join(' | ');
  return [
    test.scope.padEnd(8),
    test.name.padEnd(13),
    `${test.sort}/${test.order}`.padEnd(15),
    test.page.padEnd(7),
    (test.principal ? 'main' : 'info').padEnd(5),
    `seq=${result.seqScan ? 'YES' : 'no'}`.padEnd(8),
    `explain=${result.explainMs.toFixed(2)}ms`.padEnd(17),
    `p95=${result.p95Ms.toFixed(2)}ms`.padEnd(14),
    access,
  ].join(' ');
}

async function main(): Promise<void> {
  loadTestEnv(SCHEMA);
  const settings = settingsSchema.parse(process.env);
  const databaseUrl = z.url().parse(process.env.DATABASE_URL);
  const singleConnectionUrl = new URL(databaseUrl);
  singleConnectionUrl.searchParams.set('connection_limit', '1');

  const client = new PrismaClient({ datasourceUrl: singleConnectionUrl.toString(), log: [{ emit: 'event', level: 'query' }] });
  const timingClient = new PrismaClient({ datasourceUrl: databaseUrl });
  const workDir = await mkdtemp(join(tmpdir(), 'stockpile-explain-'));
  let captured: CapturedQuery[] = [];
  client.$on('query', (event) => {
    captured.push({ query: event.query, params: event.params });
  });

  try {
    await client.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    prismaCli(['migrate', 'deploy']);

    const fixture = await seed(client, settings, workDir);
    process.stdout.write(
      `Fixture: categories=${fixture.categories.join(',')} warehouses=${fixture.warehouses.join(',')} q-common=${fixture.commonTerm} q-rare=${fixture.rareTerm} q-money=${fixture.moneyTerm}\n\n`,
    );

    const listing = new ListingService();
    const service = await stockItemsService(client);
    const timedService = await stockItemsService(timingClient);
    const results: CaseResult[] = [];

    for (const test of cases(fixture)) {
      const cursor = test.page === 'cursor' ? await middleCursor(client, service, listing, test, fixture) : undefined;
      const query = stockItemsQuerySchema.parse(queryParams(test, fixture, cursor));

      captured = [];
      const page = await service.list(await service.prepare(query));
      const itemQueries = captured.filter((entry) => /\bstock_items\b/.test(entry.query));

      const explained: ExplainedQuery[] = [];
      for (const entry of itemQueries) {
        explained.push(await explain(client, entry));
      }

      for (let run = 0; run < WARMUP_RUNS; run += 1) {
        await timedService.list(await timedService.prepare(query));
      }
      const samples: number[] = [];
      for (let run = 0; run < settings.EXPLAIN_RUNS; run += 1) {
        const started = performance.now();
        await timedService.list(await timedService.prepare(query));
        samples.push(performance.now() - started);
      }

      const result: CaseResult = {
        case: test,
        items: page.items.length,
        total: page.total,
        seqScan: explained.some((entry) => entry.seqScan),
        explainMs: explained.reduce((sum, entry) => sum + entry.executionMs, 0),
        p95Ms: percentile(samples, 0.95),
        queries: explained,
      };
      results.push(result);
      process.stdout.write(`${formatRow(result)}\n`);
    }

    const breaches = (result: CaseResult): boolean => result.seqScan || result.p95Ms > settings.EXPLAIN_P95_TARGET_MS;
    const principal = results.filter((result) => result.case.principal);
    const failed = principal.filter(breaches);
    const informational = results.filter((result) => !result.case.principal && breaches(result));
    const worst = principal.reduce((current, result) => (result.p95Ms > current.p95Ms ? result : current));
    await writeFile(REPORT_PATH, JSON.stringify({ settings, schema: SCHEMA, fixture, results }, null, 2));
    process.stdout.write(
      `\n${principal.length} main cases: ${principal.filter((result) => result.seqScan).length} with Seq Scan on stock_items, ` +
        `${principal.filter((result) => result.p95Ms > settings.EXPLAIN_P95_TARGET_MS).length} over p95 ${settings.EXPLAIN_P95_TARGET_MS} ms, ` +
        `worst p95 ${worst.p95Ms.toFixed(2)} ms (${label(worst.case)})\n` +
        `${results.length - principal.length} info cases: ${informational.length} with Seq Scan or over p95\nReport: ${REPORT_PATH}\n`,
    );
    for (const result of failed) {
      process.stderr.write(`FAIL ${formatRow(result)}\n`);
    }
    if (failed.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    if (!settings.EXPLAIN_KEEP_SCHEMA) {
      await client.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`).catch(() => undefined);
    }
    await Promise.all([client.$disconnect(), timingClient.$disconnect()]);
    await rm(workDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
