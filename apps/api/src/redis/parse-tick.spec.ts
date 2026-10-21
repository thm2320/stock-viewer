import {
  parseRedisTick,
  parseTickMessage,
  truncatePayload,
} from './parse-tick.js';

const tick = (symbol: string, extra: object = {}) => ({
  symbol,
  timestamp: 1,
  price: 10.5,
  ingestedAt: 2,
  ...extra,
});

describe('parseTickMessage', () => {
  it.each(['AAPL', 'RY:TSX', 'EUR/USD', 'BRK.B', 'BTC/USD'])(
    'derives symbol %s from the channel without splitting on ":"',
    (symbol) => {
      const result = parseTickMessage(
        `ticks:${symbol}`,
        JSON.stringify(tick(symbol)),
      );
      expect(result).toMatchObject({
        ok: true,
        value: { symbol, tick: { symbol, price: 10.5 } },
      });
    },
  );

  it('uses the channel symbol when the payload symbol differs', () => {
    const result = parseTickMessage(
      'ticks:EUR/USD',
      JSON.stringify(tick('eur/usd')),
    );
    expect(result).toMatchObject({
      ok: true,
      value: { symbol: 'EUR/USD', tick: { symbol: 'EUR/USD' } },
    });
  });

  it('preserves optional fields', () => {
    const extra = { bid: 1, ask: 2, dayVolume: 3, currency: 'USD' };
    const result = parseTickMessage(
      'ticks:AAPL',
      JSON.stringify(tick('AAPL', extra)),
    );
    expect(result).toMatchObject({ ok: true, value: { tick: extra } });
  });

  it.each(['other:AAPL', 'ticks:', 'AAPL'])(
    'rejects bad channel %j',
    (channel) => {
      expect(parseTickMessage(channel, JSON.stringify(tick('AAPL')))).toEqual({
        ok: false,
        reason: 'bad_channel',
      });
    },
  );

  it('rejects invalid JSON', () => {
    expect(parseTickMessage('ticks:AAPL', '{nope')).toEqual({
      ok: false,
      reason: 'bad_json',
    });
  });

  it.each([
    ['number', '42'],
    ['null', 'null'],
    ['array', '[]'],
    ['missing price', JSON.stringify({ ...tick('AAPL'), price: undefined })],
    ['string price', JSON.stringify(tick('AAPL', { price: '1' }))],
    ['null price', JSON.stringify(tick('AAPL', { price: null }))],
    [
      'missing timestamp',
      JSON.stringify({ ...tick('AAPL'), timestamp: undefined }),
    ],
    [
      'missing ingestedAt',
      JSON.stringify({ ...tick('AAPL'), ingestedAt: undefined }),
    ],
    ['non-string symbol', JSON.stringify(tick('AAPL', { symbol: 1 }))],
  ])('rejects bad shape: %s', (_name, payload) => {
    expect(parseTickMessage('ticks:AAPL', payload)).toEqual({
      ok: false,
      reason: 'bad_shape',
    });
  });
});

describe('parseRedisTick', () => {
  it('parses a valid quote value', () => {
    expect(parseRedisTick(JSON.stringify(tick('EUR/USD')))?.price).toBe(10.5);
  });

  it.each(['{nope', '42', JSON.stringify({ symbol: 'AAPL' })])(
    'returns undefined for %s',
    (payload) => {
      expect(parseRedisTick(payload)).toBeUndefined();
    },
  );
});

describe('truncatePayload', () => {
  it('leaves short payloads and bounds long ones', () => {
    expect(truncatePayload('abc')).toBe('abc');
    expect(truncatePayload('x'.repeat(500))).toHaveLength(201);
  });
});
