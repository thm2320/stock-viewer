import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';
import { APP_CONFIG } from './../src/config.js';
import { REDIS_FACTORY } from './../src/redis/redis.tokens.js';

// No real Redis in e2e: a client that connects and subscribes instantly
const fakeRedis = () => ({
  on: () => undefined,
  connect: async () => undefined,
  psubscribe: async () => 1,
  punsubscribe: async () => 0,
  get: async () => null,
  quit: async () => 'OK',
  disconnect: () => undefined,
});

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(APP_CONFIG)
      .useValue({
        redisUrl: 'redis://localhost:6379',
        symbols: ['AAPL'],
        port: 0,
      })
      .overrideProvider(REDIS_FACTORY)
      .useValue(fakeRedis)
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  afterEach(async () => {
    await app.close();
  });
});
