import { ConfigError, loadConfig } from './config.js';

const base = { REDIS_URL: 'redis://localhost:6379' };

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig(base)).toEqual({
      redisUrl: 'redis://localhost:6379',
      symbols: ['AAPL'],
      port: 3002,
    });
  });

  it.each([undefined, ''])('requires REDIS_URL (%j)', (REDIS_URL) => {
    expect(() => loadConfig({ REDIS_URL })).toThrow(ConfigError);
    expect(() => loadConfig({ REDIS_URL })).toThrow(/REDIS_URL/);
  });

  it.each(['http://localhost:6379', 'not a url', 'localhost:6379'])(
    'rejects invalid REDIS_URL %s',
    (REDIS_URL) => {
      expect(() => loadConfig({ REDIS_URL })).toThrow(/Invalid REDIS_URL/);
    },
  );

  it('accepts rediss:// and does not leak the password in errors', () => {
    expect(loadConfig({ REDIS_URL: 'rediss://:pw@host:6380' }).redisUrl).toBe(
      'rediss://:pw@host:6380',
    );
    expect(() => loadConfig({ REDIS_URL: 'http://:s3cret@host' })).toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('s3cret'),
      }),
    );
  });

  it('trims, drops empties and dedupes SYMBOLS case-insensitively', () => {
    const { symbols } = loadConfig({
      ...base,
      SYMBOLS: ' AAPL, ,EUR/USD,aapl,RY:TSX,eur/usd ',
    });
    expect(symbols).toEqual(['AAPL', 'EUR/USD', 'RY:TSX']);
  });

  it.each(['AAPL,*', 'A?B', 'A[1]', 'A\\B', 'A B'])(
    'rejects SYMBOLS with glob/invalid characters: %s',
    (SYMBOLS) => {
      expect(() => loadConfig({ ...base, SYMBOLS })).toThrow(ConfigError);
    },
  );

  it('rejects an empty SYMBOLS list', () => {
    expect(() => loadConfig({ ...base, SYMBOLS: ' , ' })).toThrow(/at least one/);
  });

  it('parses PORT and validates bounds', () => {
    expect(loadConfig({ ...base, PORT: '8080' }).port).toBe(8080);
    for (const PORT of ['0', '65536', 'abc', '1.5', '-1']) {
      expect(() => loadConfig({ ...base, PORT })).toThrow(/PORT/);
    }
  });
});
