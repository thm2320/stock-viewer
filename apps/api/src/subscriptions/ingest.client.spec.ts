import type { ConfigService } from '@nestjs/config';
import { IngestClient } from './ingest.client.js';

const config = {
  get: (key: string) =>
    ({ INGEST_URL: 'http://ingest:3003', INGEST_TOKEN: 'tok' })[key],
} as unknown as ConfigService;

function reply(status: number, body?: unknown) {
  return Promise.resolve(
    new Response(body === undefined ? null : JSON.stringify(body), { status }),
  );
}

describe('IngestClient', () => {
  const client = new IngestClient(config);
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('posts the symbol with the token and a timeout signal', async () => {
    fetchMock.mockReturnValue(reply(200, { symbol: 'AAPL' }));
    expect(await client.subscribe('AAPL')).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://ingest:3003/subscriptions');
    expect(init.method).toBe('POST');
    expect(init.headers['x-ingest-token']).toBe('tok');
    expect(init.body).toBe(JSON.stringify({ symbol: 'AAPL' }));
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    [400, 'invalid'],
    [422, 'unsupported'],
    [409, 'capacity'],
  ])('maps %i to %s', async (status, error) => {
    fetchMock.mockReturnValue(reply(status, { error }));
    expect(await client.subscribe('AAPL')).toEqual({ ok: false, error });
  });

  it('maps by status when the error body is missing or unknown', async () => {
    fetchMock.mockReturnValueOnce(reply(422));
    expect(await client.subscribe('X')).toEqual({
      ok: false,
      error: 'unsupported',
    });
    fetchMock.mockReturnValueOnce(reply(409, { error: 'bogus' }));
    expect(await client.subscribe('X')).toEqual({
      ok: false,
      error: 'capacity',
    });
  });

  it.each([401, 500, 502, 404])('maps %i to unavailable', async (status) => {
    fetchMock.mockReturnValue(reply(status));
    expect(await client.subscribe('AAPL')).toEqual({
      ok: false,
      error: 'unavailable',
    });
  });

  it('maps network errors and timeouts to unavailable', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await client.subscribe('AAPL')).toEqual({
      ok: false,
      error: 'unavailable',
    });
    fetchMock.mockRejectedValueOnce(new DOMException('t', 'TimeoutError'));
    expect(await client.subscribe('AAPL')).toEqual({
      ok: false,
      error: 'unavailable',
    });
  });
});
