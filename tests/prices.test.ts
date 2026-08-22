import { describe, expect, it } from 'vitest';
import { inlinePrice, mergePriceResponse, priceKey, type PriceMap } from '../src/prices.js';

/**
 * Prices are keyed by (network, contract) — never by symbol.
 */

const USDC_ETH = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const FAKE_USDC = '0x00000000000000000000000000000000deadbeef';

/** A real response shape, captured from the live Prices API. */
const RESPONSE = {
  data: [
    {
      network: 'eth-mainnet',
      address: USDC_ETH,
      prices: [{ currency: 'usd', value: '1.0', lastUpdatedAt: '2026-08-22T14:02:31.356Z' }],
    },
    {
      network: 'base-mainnet',
      address: USDC_BASE,
      prices: [{ currency: 'usd', value: '0.9998', lastUpdatedAt: '2026-08-22T14:02:32.149Z' }],
    },
    {
      network: 'eth-mainnet',
      address: FAKE_USDC,
      prices: [],
      error: { message: `Price not found for eth-mainnet:${FAKE_USDC}` },
    },
  ],
};

const REQUESTED = [
  { network: 'eth-mainnet', address: USDC_ETH },
  { network: 'base-mainnet', address: USDC_BASE },
  { network: 'eth-mainnet', address: FAKE_USDC },
];

describe('lookups are keyed by network + contract', () => {
  it('keys the same symbol on two chains separately', () => {
    const map = mergePriceResponse(RESPONSE, REQUESTED, 'usd', new Map());

    // Both are called "USDC". They are different contracts on different
    // chains and get independent entries.
    expect(map.get(priceKey('eth-mainnet', USDC_ETH))).toMatchObject({ kind: 'priced', usd: 1 });
    expect(map.get(priceKey('base-mainnet', USDC_BASE))).toMatchObject({
      kind: 'priced',
      usd: 0.9998,
    });
  });

  it('does not price a contract using another chain\'s entry', () => {
    const map = mergePriceResponse(RESPONSE, REQUESTED, 'usd', new Map());

    // The Base contract address on eth-mainnet is a different thing entirely,
    // and has no price.
    expect(map.get(priceKey('eth-mainnet', USDC_BASE))).toBeUndefined();
  });

  it('does not let a fake token inherit the real token\'s price by symbol', () => {
    const map = mergePriceResponse(RESPONSE, REQUESTED, 'usd', new Map());

    // A scam token calling itself USDC must not be valued at $1. This is the
    // single most damaging thing symbol-matching gets wrong.
    const fake = map.get(priceKey('eth-mainnet', FAKE_USDC));
    expect(fake?.kind).toBe('token-error');
    expect(fake).not.toMatchObject({ kind: 'priced' });
  });

  it('is case-insensitive about the contract address', () => {
    const map = mergePriceResponse(RESPONSE, REQUESTED, 'usd', new Map());
    expect(map.get(priceKey('eth-mainnet', USDC_ETH.toUpperCase()))).toMatchObject({
      kind: 'priced',
    });
  });
});

describe('per-token errors', () => {
  it('records a per-token error distinctly from a missing price', () => {
    const map = mergePriceResponse(RESPONSE, REQUESTED, 'usd', new Map());
    expect(map.get(priceKey('eth-mainnet', FAKE_USDC))?.kind).toBe('token-error');
  });

  it('keeps the API\'s own explanation', () => {
    const map = mergePriceResponse(RESPONSE, REQUESTED, 'usd', new Map());
    const entry = map.get(priceKey('eth-mainnet', FAKE_USDC));
    expect(entry).toMatchObject({ reason: expect.stringContaining('Price not found') });
  });

  it('marks a token with an empty prices array as unpriced, not zero', () => {
    const map = mergePriceResponse(
      { data: [{ network: 'eth-mainnet', address: USDC_ETH, prices: [] }] },
      [{ network: 'eth-mainnet', address: USDC_ETH }],
      'usd',
      new Map(),
    );

    const entry = map.get(priceKey('eth-mainnet', USDC_ETH));
    expect(entry?.kind).toBe('no-price');
    expect(entry).not.toMatchObject({ usd: 0 });
  });

  it('marks a requested token absent from the response as unpriced', () => {
    const map = mergePriceResponse({ data: [] }, REQUESTED, 'usd', new Map());

    // Every requested key is present in the map with an explicit status —
    // a lookup miss can never be silently read as zero.
    for (const key of REQUESTED) {
      expect(map.get(priceKey(key.network, key.address))?.kind).toBe('no-price');
    }
  });

  it('rejects an unparseable price rather than coercing it', () => {
    const map: PriceMap = mergePriceResponse(
      { data: [{ network: 'eth-mainnet', address: USDC_ETH, prices: [{ currency: 'usd', value: 'n/a' }] }] },
      [{ network: 'eth-mainnet', address: USDC_ETH }],
      'usd',
      new Map(),
    );

    // Number('n/a') is NaN; NaN in a total silently poisons the whole sum.
    expect(map.get(priceKey('eth-mainnet', USDC_ETH))?.kind).toBe('no-price');
  });

  it('ignores a price in the wrong currency', () => {
    const map = mergePriceResponse(
      { data: [{ network: 'eth-mainnet', address: USDC_ETH, prices: [{ currency: 'eur', value: '0.92' }] }] },
      [{ network: 'eth-mainnet', address: USDC_ETH }],
      'usd',
      new Map(),
    );

    expect(map.get(priceKey('eth-mainnet', USDC_ETH))?.kind).toBe('no-price');
  });
});

describe('inline prices from the Portfolio API', () => {
  it('reads a usd price off a token record', () => {
    expect(
      inlinePrice([{ currency: 'usd', value: '2429.76', lastUpdatedAt: '2026-08-22T00:00:00Z' }]),
    ).toMatchObject({ kind: 'priced', usd: 2429.76 });
  });

  it('returns null for an empty price array', () => {
    expect(inlinePrice([])).toBeNull();
  });

  it('returns null when the record has no prices at all', () => {
    expect(inlinePrice(null)).toBeNull();
    expect(inlinePrice(undefined)).toBeNull();
  });

  it('returns null rather than NaN for an unparseable value', () => {
    expect(inlinePrice([{ currency: 'usd', value: 'oops', lastUpdatedAt: '' }])).toBeNull();
  });
});
