import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { DOCS_PATH, configureApp } from '../src/app.setup';

describe('health', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports database, redis and the import queue as up', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);

    expect(response.body).toEqual({ status: 'ok', checks: { database: 'up', redis: 'up', queue: 'up' } });
  });

  it('echoes the incoming request id', async () => {
    const response = await request(app.getHttpServer()).get('/health').set('x-request-id', 'req-123').expect(200);

    expect(response.headers['x-request-id']).toBe('req-123');
  });

  it('documents the health route in the OpenAPI document', async () => {
    const response = await request(app.getHttpServer()).get(`/${DOCS_PATH}-json`).expect(200);
    const document = response.body as { paths: Record<string, { get?: { responses: Record<string, unknown> } }> };

    expect(Object.keys(document.paths['/health']?.get?.responses ?? {})).toEqual(expect.arrayContaining(['200', '503']));
  });
});
