import { describe, expect, it } from 'vitest';
import { buildValuation, scaleBalance } from '../src/valuation.js';
import { priceKey } from '../src/prices.js';
import { renderValuation } from '../src/format.js';
import type { PriceMap } from '../src/prices.js';
import type { RawToken } from '../src/types.js';

const WALLET = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const SPAM = '0x00000000000000000000000000000000deadbeef';

function token(overrides: Partial<RawToken> = {}): RawToken {
  return {
    address: WALLET.toLowerCase(),
    network: 'eth-mainnet',
    tokenAddress: USDC,
    tokenBalance: '0x' + (1_000_000n).toString(16), // 1 USDC at 6 decimals
    tokenMetadata: { symbol: 'USDC', decimals: 6, name: 'USD Coin', logo: null },
    tokenPrices: [],
    ...overrides,
  };
}

function priceMap(entries: [string, string, number][]): PriceMap {
  const map: PriceMap = new Map();
  for (const [network, address, usd] of entries) {
    map.set(priceKey(network, address), { kind: 'priced', usd, lastUpdatedAt: null });
  }
  return map;
}

const BASE = {
  partialErrors: [],
  networksRequested: ['eth-mainnet', 'base-mainnet'],
  pagesFetched: 1,
  addresses: [WALLET],
};

/**
 * The arithmetic that decides whether the headline number can be trusted.
 */
describe('a holding with no price is excluded, never counted as $0', () => {
  it('leaves an unpriced holding out of the total', () => {
    const result = buildValuation({
      ...BASE,
      tokens: [
        token({ tokenAddress: USDC, tokenBalance: '0x' + (5_000_000n).toString(16) }),
        token({
          tokenAddress: SPAM,
          tokenBalance: '0x' + (999_000_000_000_000_000_000n).toString(16),
          tokenMetadata: { symbol: 'SPAM', decimals: 18, name: 'Spam', logo: null },
        }),
      ],
      prices: priceMap([['eth-mainnet', USDC, 1]]),
    });

    // Only the 5 USDC counts. The unpriced token contributes nothing —
    // and is not silently added as 0 either.
    expect(result.totalUsd).toBeCloseTo(5, 6);
    expect(result.unpriced).toHaveLength(1);
    expect(result.unpriced[0]?.symbol).toBe('SPAM');
  });

  it('gives an unpriced holding a null value, not zero', () => {
    const result = buildValuation({
      ...BASE,
      tokens: [token({ tokenAddress: SPAM })],
      prices: new Map(),
    });

    // null means "unknown"; 0 would mean "known to be worthless".
    expect(result.holdings[0]?.valueUsd).toBeNull();
    expect(result.holdings[0]?.valueUsd).not.toBe(0);
  });

  it('reports how many holdings were excluded', () => {
    const result = buildValuation({
      ...BASE,
      tokens: [
        token({ tokenAddress: USDC }),
        token({ tokenAddress: SPAM, tokenMetadata: { symbol: 'A', decimals: 18, name: null, logo: null } }),
        token({ tokenAddress: '0x' + 'ab'.repeat(20), tokenMetadata: { symbol: 'B', decimals: 18, name: null, logo: null } }),
      ],
      prices: priceMap([['eth-mainnet', USDC, 1]]),
    });

    expect(result.unpriced).toHaveLength(2);
    expect(renderValuation(result)).toMatch(/Excluded from the total/);
  });

  it('a wallet where nothing can be priced totals 0 but says why', () => {
    const result = buildValuation({
      ...BASE,
      tokens: [token({ tokenAddress: SPAM })],
      prices: new Map(),
    });

    expect(result.totalUsd).toBe(0);
    expect(result.unpriced).toHaveLength(1);
    expect(renderValuation(result)).toMatch(/no usable price/);
  });
});

describe('per-token errors are separate from network failures', () => {
  it('classifies a per-token API error distinctly', () => {
    const map: PriceMap = new Map();
    map.set(priceKey('eth-mainnet', SPAM), {
      kind: 'token-error',
      reason: 'Price not found for eth-mainnet:0x…deadbeef',
    });

    const result = buildValuation({
      ...BASE,
      tokens: [token({ tokenAddress: SPAM })],
      prices: map,
    });

    expect(result.tokenErrors).toHaveLength(1);
    // Not counted as a network failure — the network reported fine.
    expect(result.failedNetworks).toHaveLength(0);
    expect(result.complete).toBe(true);
  });

  it('a per-token error alone does not make the whole total untrustworthy', () => {
    const map: PriceMap = new Map();
    map.set(priceKey('eth-mainnet', SPAM), { kind: 'token-error', reason: 'no price' });

    const result = buildValuation({
      ...BASE,
      tokens: [token({ tokenAddress: USDC }), token({ tokenAddress: SPAM })],
      prices: new Map([...priceMap([['eth-mainnet', USDC, 1]]), ...map]),
    });

    expect(result.complete).toBe(true);
    expect(result.tokenErrors).toHaveLength(1);
  });

  it('a network failure DOES make the total incomplete', () => {
    const result = buildValuation({
      ...BASE,
      tokens: [token({ tokenAddress: USDC })],
      prices: priceMap([['eth-mainnet', USDC, 1]]),
      partialErrors: [{ network: 'base-mainnet', message: 'upstream timeout' }],
    });

    expect(result.complete).toBe(false);
    expect(result.failedNetworks).toHaveLength(1);
  });

  it('honours a per-token error reported on the token record itself', () => {
    const result = buildValuation({
      ...BASE,
      tokens: [token({ tokenAddress: SPAM, error: { message: 'metadata unavailable' } })],
      prices: new Map(),
    });

    expect(result.tokenErrors).toHaveLength(1);
    expect(result.tokenErrors[0]?.price).toMatchObject({ reason: 'metadata unavailable' });
  });
});

describe('the report visibly distinguishes partial from complete', () => {
  const tokens = [token({ tokenAddress: USDC })];
  const prices = priceMap([['eth-mainnet', USDC, 1]]);

  const complete = buildValuation({ ...BASE, tokens, prices });
  const partial = buildValuation({
    ...BASE,
    tokens,
    prices,
    partialErrors: [{ network: 'base-mainnet', message: 'upstream timeout' }],
  });

  it('labels a complete total "TOTAL"', () => {
    const output = renderValuation(complete);
    expect(output).toMatch(/TOTAL/);
    expect(output).not.toMatch(/INCOMPLETE/);
  });

  it('labels a partial total as an incomplete lower bound', () => {
    const output = renderValuation(partial);
    expect(output).toMatch(/INCOMPLETE/);
    expect(output).toMatch(/AT LEAST/);
  });

  it('names the failed network in the output', () => {
    expect(renderValuation(partial)).toMatch(/base-mainnet/);
    expect(renderValuation(partial)).toMatch(/upstream timeout/);
  });

  it('renders differently even though the totals are identical', () => {
    // Same number, different report. This is the whole point.
    expect(complete.totalUsd).toBe(partial.totalUsd);
    expect(renderValuation(complete)).not.toBe(renderValuation(partial));
  });

  it('repeats the warning at the end so a long report cannot hide it', () => {
    const output = renderValuation(partial);
    const occurrences = output.match(/INCOMPLETE|Reminder/g) ?? [];
    expect(occurrences.length).toBeGreaterThan(1);
  });
});

describe('balance scaling', () => {
  it('scales by decimals', () => {
    expect(scaleBalance(1_000_000n, 6)).toBe(1);
    expect(scaleBalance(1_500_000n, 6)).toBe(1.5);
  });

  it('keeps precision on balances beyond Number.MAX_SAFE_INTEGER', () => {
    // 1234567.891 ETH — naive Number(raw) / 1e18 loses digits before dividing.
    expect(scaleBalance(1_234_567_891_000_000_000_000_000n, 18)).toBeCloseTo(1_234_567.891, 3);
  });

  it('handles zero decimals', () => {
    expect(scaleBalance(42n, 0)).toBe(42);
  });

  it('handles a zero balance', () => {
    expect(scaleBalance(0n, 18)).toBe(0);
  });
});

describe('breakdown', () => {
  it('lists every requested network, including empty ones', () => {
    const result = buildValuation({
      ...BASE,
      tokens: [token({ tokenAddress: USDC })],
      prices: priceMap([['eth-mainnet', USDC, 1]]),
    });

    // base-mainnet has no holdings but must still appear — an absent row
    // would be indistinguishable from a failed one.
    expect(result.breakdown.map((b) => b.network)).toContain('base-mainnet');
  });

  it('marks a failed network as failed rather than $0', () => {
    const result = buildValuation({
      ...BASE,
      tokens: [token({ tokenAddress: USDC })],
      prices: priceMap([['eth-mainnet', USDC, 1]]),
      partialErrors: [{ network: 'base-mainnet', message: 'down' }],
    });

    const base = result.breakdown.find((b) => b.network === 'base-mainnet');
    expect(base?.failed).toBe(true);
    expect(renderValuation(result)).toMatch(/FAILED/);
  });

  it('drops zero-balance token records', () => {
    const result = buildValuation({
      ...BASE,
      tokens: [token({ tokenAddress: USDC }), token({ tokenAddress: SPAM, tokenBalance: '0x0' })],
      prices: priceMap([['eth-mainnet', USDC, 1]]),
    });

    expect(result.holdings).toHaveLength(1);
  });
});
