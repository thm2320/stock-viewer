import { HttpException } from '@nestjs/common';
import type { IngestClient } from './ingest.client.js';
import { SubscriptionsController } from './subscriptions.controller.js';

describe('SubscriptionsController', () => {
  const subscribe = vi.fn();
  const controller = new SubscriptionsController({
    subscribe,
  } as unknown as IngestClient);

  beforeEach(() => subscribe.mockReset());

  async function failure(body: unknown) {
    const err = await controller.subscribe(body).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    const e = err as HttpException;
    return { status: e.getStatus(), body: e.getResponse() };
  }

  it('returns the symbol on success', async () => {
    subscribe.mockResolvedValue({ ok: true });
    await expect(controller.subscribe({ symbol: 'EUR/USD' })).resolves.toEqual({
      symbol: 'EUR/USD',
    });
    expect(subscribe).toHaveBeenCalledWith('EUR/USD');
  });

  it.each([
    undefined,
    null,
    {},
    { symbol: 5 },
    { symbol: '' },
    { symbol: 'A*' },
  ])(
    'rejects invalid body %j with 400 without calling ingest',
    async (body) => {
      expect(await failure(body)).toEqual({
        status: 400,
        body: { error: 'invalid' },
      });
      expect(subscribe).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['invalid', 400],
    ['unsupported', 422],
    ['capacity', 409],
    ['unavailable', 503],
  ])('maps ingest %s to HTTP %i', async (error, status) => {
    subscribe.mockResolvedValue({ ok: false, error });
    expect(await failure({ symbol: 'AAPL' })).toEqual({
      status,
      body: { error },
    });
  });
});
