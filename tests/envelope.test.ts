import { describe, expect, it } from 'vitest';
import { parsePortfolioResponse, PortfolioApiError } from '../src/portfolio.js';

/**
 * The partial-failure envelope.
 *
 * A network can fail while the request returns HTTP 200 with a populated
 * `data.tokens`. The ONLY signal is a top-level `error.partialErrors` list.
 * A real outage cannot be summoned on demand, so the parser is a pure function
 * and these fixtures exercise the path directly.
 */

const HEALTHY_TOKEN = {
  address: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
  network: 'eth-mainnet',
  tokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  tokenBalance: '0x0f4240',
  tokenMetadata: { symbol: 'USDC', decimals: 6, name: 'USD Coin', logo: null },
  tokenPrices: [{ currency: 'usd', value: '1.0', lastUpdatedAt: '2026-08-22T00:00:00Z' }],
};

describe('a fully successful response', () => {
  it('returns tokens and reports no partial errors', () => {
    const result = parsePortfolioResponse({ data: { tokens: [HEALTHY_TOKEN], pageKey: null } });

    expect(result.tokens).toHaveLength(1);
    expect(result.partialErrors).toEqual([]);
  });

  it('carries the pageKey through so pagination can be drained', () => {
    const result = parsePortfolioResponse({ data: { tokens: [], pageKey: 'abc-123' } });
    expect(result.pageKey).toBe('abc-123');
  });

  it('reports a null pageKey on the last page', () => {
    expect(parsePortfolioResponse({ data: { tokens: [] } }).pageKey).toBeNull();
  });
});

describe('partial failure — HTTP 200, but a network is missing', () => {
  /** The shape that makes this problem what it is. */
  const partialResponse = {
    data: { tokens: [HEALTHY_TOKEN], pageKey: null },
    error: {
      partialErrors: [
        { network: 'base-mainnet', message: 'Internal error fetching data for base-mainnet' },
        { network: 'opt-mainnet', message: 'upstream timeout' },
      ],
    },
  };

  it('surfaces the failed networks instead of ignoring them', () => {
    const result = parsePortfolioResponse(partialResponse);

    expect(result.partialErrors).toHaveLength(2);
    expect(result.partialErrors.map((e) => e.network)).toEqual([
      'base-mainnet',
      'opt-mainnet',
    ]);
  });

  it('still returns the data that DID arrive', () => {
    // The successful networks are usable — the point is to know they are
    // incomplete, not to throw everything away.
    expect(parsePortfolioResponse(partialResponse).tokens).toHaveLength(1);
  });

  it('carries the failure message for each network', () => {
    const result = parsePortfolioResponse(partialResponse);
    expect(result.partialErrors[0]?.message).toMatch(/Internal error/);
  });

  it('is distinguishable from an identical response without the error key', () => {
    const clean = parsePortfolioResponse({ data: { tokens: [HEALTHY_TOKEN], pageKey: null } });
    const partial = parsePortfolioResponse(partialResponse);

    // Same tokens, different trustworthiness. If these compared equal, a
    // partial result would be indistinguishable from a complete one.
    expect(clean.tokens).toEqual(partial.tokens);
    expect(clean.partialErrors.length).not.toBe(partial.partialErrors.length);
  });

  it('tolerates an alternative field name for the network', () => {
    const result = parsePortfolioResponse({
      data: { tokens: [] },
      error: { partialErrors: [{ networkId: 'matic-mainnet', message: 'down' }] },
    });

    expect(result.partialErrors[0]?.network).toBe('matic-mainnet');
  });

  it('does not lose an unrecognisably-shaped partial error', () => {
    const result = parsePortfolioResponse({
      data: { tokens: [] },
      error: { partialErrors: ['something went wrong'] },
    });

    // Better to report an unknown failure than to silently drop it.
    expect(result.partialErrors).toHaveLength(1);
  });
});

describe('fatal errors', () => {
  it('throws when a top-level error has no partialErrors list', () => {
    expect(() =>
      parsePortfolioResponse({ error: { message: 'Unsupported network: not-a-real-network' } }),
    ).toThrow(PortfolioApiError);
  });

  it('includes the API message in the thrown error', () => {
    expect(() => parsePortfolioResponse({ error: { message: 'Invalid API key' } })).toThrow(
      /Invalid API key/,
    );
  });

  it('throws when the body has no data object', () => {
    expect(() => parsePortfolioResponse({ something: 'else' })).toThrow(PortfolioApiError);
  });

  it('throws on a non-object body', () => {
    expect(() => parsePortfolioResponse('nope')).toThrow(PortfolioApiError);
    expect(() => parsePortfolioResponse(null)).toThrow(PortfolioApiError);
  });

  it('treats an empty partialErrors array as a fatal error, not a partial one', () => {
    // An `error` key with nothing partial in it is a whole-request failure.
    expect(() => parsePortfolioResponse({ data: { tokens: [] }, error: { partialErrors: [] } })).toThrow(
      PortfolioApiError,
    );
  });
});
