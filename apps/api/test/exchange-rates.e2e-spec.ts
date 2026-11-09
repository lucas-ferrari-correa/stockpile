import { IncomingMessage, Server, ServerResponse, createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { INestApplication, LoggerService } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BASE_CURRENCY } from '@stockpile/shared';
import Redis from 'ioredis';
import { AppModule } from '../src/app.module';
import { AppConfigService } from '../src/infra/config/app-config.service';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { REDIS } from '../src/infra/redis/redis.constants';
import { FawazExchangeRatesProvider } from '../src/modules/exchange-rates/adapters/fawaz-exchange-rates.provider';
import {
  RATES_CACHE_TTL_SECONDS,
  RedisCachedExchangeRatesProvider,
  ratesCacheKey,
} from '../src/modules/exchange-rates/adapters/redis-cached-exchange-rates.provider';
import {
  MissingCurrencyError,
  SnapshotAlreadyExistsError,
} from '../src/modules/exchange-rates/application/exchange-rates.errors';
import { ExchangeRatesService } from '../src/modules/exchange-rates/application/exchange-rates.service';
import {
  EXCHANGE_RATES_PROVIDER,
  ExchangeRatesProvider,
  ExchangeRatesUnavailableError,
  LatestRates,
} from '../src/modules/exchange-rates/ports/exchange-rates.provider';

type HostReply = { status: number; body: unknown } | 'hang';

interface FakeHost {
  baseUrl: string;
  host: string;
  paths: string[];
  close(): Promise<void>;
}

const VALID_BODY = { date: '2026-03-04', usd: { eur: 0.9, jpy: 150.5 } };

async function startHost(reply: (hit: number) => HostReply): Promise<FakeHost> {
  const paths: string[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    paths.push(req.url ?? '');
    const outcome = reply(paths.length);
    if (outcome === 'hang') {
      return;
    }
    res.writeHead(outcome.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(outcome.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Fake host has no TCP address');
  }
  const host = `127.0.0.1:${address.port}`;
  return {
    baseUrl: `http://${host}/v1`,
    host,
    paths,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function always(outcome: HostReply): (hit: number) => HostReply {
  return () => outcome;
}

class RecordingLogger implements LoggerService {
  readonly warnings: string[] = [];

  log(): void {}

  error(): void {}

  warn(_context: unknown, message: string): void {
    this.warnings.push(message);
  }
}

class FakeRatesProvider implements ExchangeRatesProvider {
  readonly calls: string[] = [];
  next: LatestRates | Error = { date: '2026-03-04', rates: {}, source: 'fake.test' };
  gate: Promise<void> = Promise.resolve();

  async fetchLatest(base: string): Promise<LatestRates> {
    this.calls.push(base);
    await this.gate;
    if (this.next instanceof Error) {
      throw this.next;
    }
    return this.next;
  }
}

describe('exchange rates', () => {
  describe('fawaz provider', () => {
    const hosts: FakeHost[] = [];

    async function host(reply: (hit: number) => HostReply): Promise<FakeHost> {
      const started = await startHost(reply);
      hosts.push(started);
      return started;
    }

    function providerFor(...fakeHosts: FakeHost[]): FawazExchangeRatesProvider {
      return new FawazExchangeRatesProvider({ baseUrls: fakeHosts.map((item) => item.baseUrl), timeoutMs: 200 });
    }

    afterEach(async () => {
      await Promise.all(hosts.splice(0).map((item) => item.close()));
    });

    it('returns the primary host rates with uppercase keys and positive values only', async () => {
      const primary = await host(
        always({ status: 200, body: { date: '2026-03-04', usd: { eur: 0.9, jpy: 150.5, zero: 0, neg: -1 } } }),
      );
      const fallback = await host(always({ status: 200, body: VALID_BODY }));

      const latest = await providerFor(primary, fallback).fetchLatest('USD');

      expect(latest).toEqual({ date: '2026-03-04', rates: { EUR: 0.9, JPY: 150.5 }, source: primary.host });
      expect(primary.paths).toEqual(['/v1/currencies/usd.min.json']);
      expect(fallback.paths).toEqual([]);
    });

    it('retries the primary host once before succeeding on it', async () => {
      const primary = await host((hit) => (hit === 1 ? { status: 503, body: {} } : { status: 200, body: VALID_BODY }));
      const fallback = await host(always({ status: 200, body: VALID_BODY }));

      const latest = await providerFor(primary, fallback).fetchLatest('USD');

      expect(latest.source).toBe(primary.host);
      expect(primary.paths).toHaveLength(2);
      expect(fallback.paths).toHaveLength(0);
    });

    it.each<[string, HostReply]>([
      ['a server error', { status: 500, body: { message: 'boom' } }],
      ['a timeout', 'hang'],
      ['a body without the base currency', { status: 200, body: { date: '2026-03-04', eur: { usd: 1.1 } } }],
      ['a malformed date', { status: 200, body: { date: '04/03/2026', usd: { eur: 0.9 } } }],
      ['an out-of-range date', { status: 200, body: { date: '2026-13-45', usd: { eur: 0.9 } } }],
      ['non-json content', { status: 200, body: undefined }],
    ])('falls back after two attempts on a primary answering with %s', async (_label, reply) => {
      const primary = await host(always(reply));
      const fallback = await host(always({ status: 200, body: VALID_BODY }));

      const latest = await providerFor(primary, fallback).fetchLatest('USD');

      expect(latest).toEqual({ date: '2026-03-04', rates: { EUR: 0.9, JPY: 150.5 }, source: fallback.host });
      expect(primary.paths).toHaveLength(2);
      expect(fallback.paths).toHaveLength(1);
    });

    it('fails with every attempt listed when all hosts fail', async () => {
      const primary = await host(always({ status: 500, body: {} }));
      const fallback = await host(always('hang'));

      const failure: unknown = await providerFor(primary, fallback)
        .fetchLatest('usd')
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ExchangeRatesUnavailableError);
      expect(failure).toMatchObject({ code: 'RATES_UNAVAILABLE', base: 'USD' });
      const attempts = failure instanceof ExchangeRatesUnavailableError ? failure.attempts : [];
      expect(attempts).toHaveLength(4);
      expect(attempts.filter((attempt) => attempt.includes(primary.host))).toHaveLength(2);
      expect(attempts.filter((attempt) => attempt.includes(fallback.host))).toHaveLength(2);
      expect(primary.paths).toHaveLength(2);
      expect(fallback.paths).toHaveLength(2);
    });
  });

  describe('configured provider', () => {
    const PRIMARY_URL = 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json';
    const FALLBACK_URL = 'https://latest.currency-api.pages.dev/v1/currencies/usd.min.json';
    const TIMEOUT_MS = 100;
    let app: INestApplication;
    let redis: Redis;
    let provider: ExchangeRatesProvider;
    let previousTimeout: string | undefined;
    let requested: string[];
    let fetchSpy: jest.SpiedFunction<typeof fetch>;

    function requestUrl(input: string | URL | Request): string {
      return input instanceof Request ? input.url : String(input);
    }

    function fakeFetch(reply: (url: string, signal: AbortSignal | null | undefined) => Promise<Response>): void {
      fetchSpy.mockImplementation((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = requestUrl(input);
        requested.push(url);
        return reply(url, init?.signal);
      });
    }

    function json(body: unknown): Response {
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    function todayKey(): string {
      return ratesCacheKey(BASE_CURRENCY, new Date());
    }

    beforeAll(async () => {
      previousTimeout = process.env.EXCHANGE_RATES_TIMEOUT_MS;
      process.env.EXCHANGE_RATES_TIMEOUT_MS = String(TIMEOUT_MS);
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      await app.init();
      redis = app.get<Redis>(REDIS);
      provider = app.get<ExchangeRatesProvider>(EXCHANGE_RATES_PROVIDER);
    });

    afterAll(async () => {
      await redis.del(todayKey());
      await app.close();
      if (previousTimeout === undefined) {
        delete process.env.EXCHANGE_RATES_TIMEOUT_MS;
      } else {
        process.env.EXCHANGE_RATES_TIMEOUT_MS = previousTimeout;
      }
    });

    beforeEach(async () => {
      requested = [];
      fetchSpy = jest.spyOn(globalThis, 'fetch');
      await redis.del(todayKey());
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it('serves jsDelivr rates and caches them under the UTC day key for one day', async () => {
      fakeFetch(() => Promise.resolve(json(VALID_BODY)));

      const latest = await provider.fetchLatest('USD');

      expect(latest).toEqual({ date: '2026-03-04', rates: { EUR: 0.9, JPY: 150.5 }, source: 'cdn.jsdelivr.net' });
      expect(requested).toEqual([PRIMARY_URL]);
      const key = todayKey();
      expect(key).toBe(`rates:usd:${new Date().toISOString().slice(0, 10)}`);
      expect(JSON.parse((await redis.get(key)) ?? 'null')).toEqual(latest);
      const ttl = await redis.ttl(key);
      expect(ttl).toBeGreaterThan(86400 - 10);
      expect(ttl).toBeLessThanOrEqual(86400);
    });

    it('falls back to pages.dev after both jsDelivr attempts fail', async () => {
      fakeFetch((url) =>
        Promise.resolve(url === PRIMARY_URL ? new Response('{}', { status: 503 }) : json(VALID_BODY)),
      );

      const latest = await provider.fetchLatest('USD');

      expect(latest.source).toBe('latest.currency-api.pages.dev');
      expect(requested).toEqual([PRIMARY_URL, PRIMARY_URL, FALLBACK_URL]);
    });

    it('aborts each attempt after EXCHANGE_RATES_TIMEOUT_MS and caches nothing when every host hangs', async () => {
      fakeFetch(
        (url, signal) =>
          new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error(`aborted ${url}`)));
          }),
      );
      const startedAt = Date.now();

      const failure: unknown = await provider.fetchLatest('USD').catch((error: unknown) => error);

      const elapsed = Date.now() - startedAt;
      expect(failure).toMatchObject({ code: 'RATES_UNAVAILABLE', base: 'USD' });
      expect(requested).toEqual([PRIMARY_URL, PRIMARY_URL, FALLBACK_URL, FALLBACK_URL]);
      expect(elapsed).toBeGreaterThanOrEqual(4 * TIMEOUT_MS - 20);
      expect(elapsed).toBeLessThan(2000);
      expect(await redis.exists(todayKey())).toBe(0);
    });
  });

  describe('with the application', () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let redis: Redis;
    let currencies: readonly string[];
    const fake = new FakeRatesProvider();

    function ratesFor(codes: readonly string[]): Record<string, number> {
      return Object.fromEntries(codes.map((code, index) => [code, index + 1.25]));
    }

    async function seedImport(): Promise<string> {
      const created = await prisma.import.create({
        data: { fileName: 'products.csv' },
        select: { id: true },
      });
      return created.id;
    }

    async function snapshotCount(importId: string): Promise<number> {
      return prisma.exchangeRateSnapshot.count({ where: { importId } });
    }

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EXCHANGE_RATES_PROVIDER)
        .useValue(fake)
        .compile();
      app = moduleRef.createNestApplication();
      await app.init();
      prisma = app.get(PrismaService);
      redis = app.get<Redis>(REDIS);
      currencies = app.get(AppConfigService).get('EXCHANGE_CURRENCIES');
    });

    afterAll(async () => {
      await app.close();
    });

    describe('redis cache', () => {
      const day = new Date('2001-02-03T12:00:00.000Z');
      const cachedKeys = ['rates:usd:2001-02-03', 'rates:usd:2001-02-04'];
      const fresh: LatestRates = { date: '2001-02-03', rates: { EUR: 0.9 }, source: 'inner.test' };
      let inner: FakeRatesProvider;

      function cached(now: () => Date = () => day): RedisCachedExchangeRatesProvider {
        return new RedisCachedExchangeRatesProvider(inner, redis, { now });
      }

      beforeEach(async () => {
        inner = new FakeRatesProvider();
        inner.next = fresh;
        await redis.del(...cachedKeys);
      });

      afterAll(async () => {
        await redis.del(...cachedKeys);
      });

      it('fetches from the inner provider on a miss and stores the result for a day', async () => {
        const latest = await cached().fetchLatest('USD');

        expect(latest).toEqual(fresh);
        expect(inner.calls).toEqual(['USD']);
        const stored = await redis.get('rates:usd:2001-02-03');
        expect(JSON.parse(stored ?? 'null')).toEqual(fresh);
        const ttl = await redis.ttl('rates:usd:2001-02-03');
        expect(RATES_CACHE_TTL_SECONDS).toBe(86400);
        expect(ttl).toBeGreaterThan(86400 - 10);
        expect(ttl).toBeLessThanOrEqual(86400);
      });

      it('serves a cached entry without calling the inner provider', async () => {
        const stored: LatestRates = { date: '2001-02-02', rates: { GBP: 0.8 }, source: 'cache.test' };
        await redis.set('rates:usd:2001-02-03', JSON.stringify(stored), 'EX', 60);

        const latest = await cached().fetchLatest('USD');

        expect(latest).toEqual(stored);
        expect(inner.calls).toEqual([]);
      });

      it.each<[string, string]>([
        ['invalid json', 'not-json'],
        ['an unexpected shape', JSON.stringify({ date: '2001-02-03', rates: { EUR: 'high' } })],
      ])('treats a cached entry with %s as a miss and replaces it', async (_label, raw) => {
        await redis.set('rates:usd:2001-02-03', raw, 'EX', 60);

        const latest = await cached().fetchLatest('USD');

        expect(latest).toEqual(fresh);
        expect(inner.calls).toEqual(['USD']);
        expect(JSON.parse((await redis.get('rates:usd:2001-02-03')) ?? 'null')).toEqual(fresh);
      });

      it('keys entries by the UTC day so a new day fetches again', async () => {
        let now = new Date('2001-02-03T20:59:59.000-03:00');
        const provider = cached(() => now);

        await provider.fetchLatest('USD');
        await provider.fetchLatest('USD');
        now = new Date('2001-02-03T21:00:00.000-03:00');
        await provider.fetchLatest('USD');

        expect(ratesCacheKey('USD', new Date('2001-02-03T21:00:00.000-03:00'))).toBe('rates:usd:2001-02-04');
        expect(inner.calls).toEqual(['USD', 'USD']);
        expect(await redis.exists(...cachedKeys)).toBe(2);
      });

      it('falls back to the inner provider when reading the cache fails and replaces the entry', async () => {
        const logger = new RecordingLogger();
        await redis.hset('rates:usd:2001-02-03', 'unexpected', 'hash');

        const latest = await new RedisCachedExchangeRatesProvider(inner, redis, { now: () => day, logger }).fetchLatest('USD');

        expect(latest).toEqual(fresh);
        expect(inner.calls).toEqual(['USD']);
        expect(JSON.parse((await redis.get('rates:usd:2001-02-03')) ?? 'null')).toEqual(fresh);
        expect(logger.warnings).toEqual(['Exchange rates cache read failed']);
      });

      it('returns the inner rates when the cache can be neither read nor written', async () => {
        const logger = new RecordingLogger();
        const unreachable = new Redis({ host: '127.0.0.1', port: 1, lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0 });

        try {
          const latest = await new RedisCachedExchangeRatesProvider(inner, unreachable, { now: () => day, logger }).fetchLatest('USD');

          expect(latest).toEqual(fresh);
          expect(inner.calls).toEqual(['USD']);
          expect(logger.warnings).toEqual(['Exchange rates cache read failed', 'Exchange rates cache write failed']);
        } finally {
          unreachable.disconnect();
        }
      });

      it('caches nothing when the inner provider fails', async () => {
        inner.next = new ExchangeRatesUnavailableError('USD', ['primary down']);

        await expect(cached().fetchLatest('USD')).rejects.toBeInstanceOf(ExchangeRatesUnavailableError);

        expect(await redis.exists('rates:usd:2001-02-03')).toBe(0);
      });
    });

    describe('snapshot capture', () => {
      let service: ExchangeRatesService;

      beforeAll(() => {
        service = app.get(ExchangeRatesService);
      });

      beforeEach(async () => {
        await prisma.import.deleteMany();
        fake.calls.length = 0;
        fake.gate = Promise.resolve();
        fake.next = {
          date: '2026-03-04',
          rates: { ...ratesFor(currencies), AUD: 1.5, XYZ: 2 },
          source: 'rates.example.test',
        };
      });

      it('stores a USD snapshot with only the configured currencies', async () => {
        const importId = await seedImport();

        const snapshot = await service.captureSnapshot(importId);

        expect(fake.calls).toEqual([BASE_CURRENCY]);
        expect(snapshot).toMatchObject({
          importId,
          base: 'USD',
          rateDate: '2026-03-04',
          source: 'rates.example.test',
          rates: ratesFor(currencies),
        });
        const row = await prisma.exchangeRateSnapshot.findUniqueOrThrow({
          where: { importId },
          select: { base: true, rateDate: true, fetchedAt: true, source: true, rates: true },
        });
        expect(row).toEqual({
          base: 'USD',
          rateDate: new Date('2026-03-04T00:00:00.000Z'),
          fetchedAt: snapshot.fetchedAt,
          source: 'rates.example.test',
          rates: ratesFor(currencies),
        });
      });

      it('refuses a second snapshot for the same import without fetching rates again', async () => {
        const importId = await seedImport();
        await service.captureSnapshot(importId);

        await expect(service.captureSnapshot(importId)).rejects.toBeInstanceOf(SnapshotAlreadyExistsError);

        expect(fake.calls).toHaveLength(1);
        expect(await snapshotCount(importId)).toBe(1);
      });

      it('keeps a single snapshot when two captures for the same import race', async () => {
        const importId = await seedImport();
        let release: () => void = () => undefined;
        fake.gate = new Promise<void>((resolve) => {
          release = resolve;
        });

        const racing = Promise.allSettled([service.captureSnapshot(importId), service.captureSnapshot(importId)]);
        while (fake.calls.length < 2) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        release();
        const outcomes = await racing;

        expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
        const reasons: unknown[] = outcomes
          .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
          .map((outcome): unknown => outcome.reason);
        expect(reasons[0]).toBeInstanceOf(SnapshotAlreadyExistsError);
        expect(await snapshotCount(importId)).toBe(1);
      });

      it('rejects rates missing a configured currency without storing a snapshot', async () => {
        const importId = await seedImport();
        const [dropped, ...kept] = currencies;
        fake.next = { date: '2026-03-04', rates: ratesFor(kept), source: 'rates.example.test' };

        const failure: unknown = await service.captureSnapshot(importId).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(MissingCurrencyError);
        expect(failure).toMatchObject({ code: 'MISSING_CURRENCY', missing: [dropped] });
        expect(await snapshotCount(importId)).toBe(0);
      });

      it('propagates an unavailable provider without storing a snapshot', async () => {
        const importId = await seedImport();
        fake.next = new ExchangeRatesUnavailableError('USD', ['primary down', 'fallback down']);

        await expect(service.captureSnapshot(importId)).rejects.toMatchObject({ code: 'RATES_UNAVAILABLE' });

        expect(await snapshotCount(importId)).toBe(0);
      });
    });
  });
});
