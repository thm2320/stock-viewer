import { ConfigError, loadConfig } from './config.js';

const base = {
  REDIS_URL: 'redis://localhost:6379',
  INGEST_URL: 'http://localhost:3003',
  INGEST_TOKEN: 'tok',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig(base)).toEqual({
      redisUrl: 'redis://localhost:6379',
      ingestUrl: 'http://localhost:3003',
      ingestToken: 'tok',
      port: 3002,
    });
  });

  it.each([undefined, ''])('requires REDIS_URL (%j)', (REDIS_URL) => {
    expect(() => loadConfig({ ...base, REDIS_URL })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, REDIS_URL })).toThrow(/REDIS_URL/);
  });

  it.each(['http://localhost:6379', 'not a url', 'localhost:6379'])(
    'rejects invalid REDIS_URL %s',
    (REDIS_URL) => {
      expect(() => loadConfig({ ...base, REDIS_URL })).toThrow(
        /Invalid REDIS_URL/,
      );
    },
  );

  it('accepts rediss:// and does not leak the password in errors', () => {
    expect(
      loadConfig({ ...base, REDIS_URL: 'rediss://:pw@host:6380' }).redisUrl,
    ).toBe('rediss://:pw@host:6380');
    expect(() =>
      loadConfig({ ...base, REDIS_URL: 'http://:s3cret@host' }),
    ).toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('s3cret'),
      }),
    );
  });

  it.each([undefined, ''])('requires INGEST_URL (%j)', (INGEST_URL) => {
    expect(() => loadConfig({ ...base, INGEST_URL })).toThrow(/INGEST_URL/);
  });

  it.each(['ftp://host', 'not a url', 'localhost:3003'])(
    'rejects invalid INGEST_URL %s',
    (INGEST_URL) => {
      expect(() => loadConfig({ ...base, INGEST_URL })).toThrow(
        /Invalid INGEST_URL/,
      );
    },
  );

  it('accepts https INGEST_URL', () => {
    expect(
      loadConfig({ ...base, INGEST_URL: 'https://ingest.internal' }).ingestUrl,
    ).toBe('https://ingest.internal');
  });

  it.each([undefined, '', '  '])(
    'requires INGEST_TOKEN (%j)',
    (INGEST_TOKEN) => {
      expect(() => loadConfig({ ...base, INGEST_TOKEN })).toThrow(
        /INGEST_TOKEN/,
      );
    },
  );

  it('does not leak INGEST_URL credentials in errors', () => {
    expect(() =>
      loadConfig({ ...base, INGEST_URL: 'ftp://user:s3cret@host' }),
    ).toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('s3cret'),
      }),
    );
  });

  it('parses PORT and validates bounds', () => {
    expect(loadConfig({ ...base, PORT: '8080' }).port).toBe(8080);
    for (const PORT of ['0', '65536', 'abc', '1.5', '-1']) {
      expect(() => loadConfig({ ...base, PORT })).toThrow(/PORT/);
    }
  });
});
