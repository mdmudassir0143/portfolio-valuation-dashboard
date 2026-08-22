/**
 * Demonstrates the partial-failure path without needing a real chain outage.
 *
 *   npm run demo:partial
 *
 * Feeds the SAME holdings through the real parser, the real valuation and the
 * real renderer twice — once with a clean envelope, once with an
 * `error.partialErrors` envelope — and prints both reports.
 *
 * The totals are identical. The reports are not. That difference is the whole
 * point of the problem: a person must never see an incomplete number presented
 * as the complete picture.
 */
import { parsePortfolioResponse } from '../src/portfolio.js';
import { priceKey, type PriceMap } from '../src/prices.js';
import { buildValuation } from '../src/valuation.js';
import { renderValuation } from '../src/format.js';

const WALLET = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const SCAM = '0x00000000000000000000000000000000deadbeef';

const NETWORKS = ['eth-mainnet', 'base-mainnet', 'opt-mainnet', 'arb-mainnet'];

/** The same token data in both scenarios. */
const TOKENS = [
  {
    address: WALLET.toLowerCase(),
    network: 'eth-mainnet',
    tokenAddress: null,
    tokenBalance: '0x' + (6_640_500_000_000_000_000n).toString(16),
    tokenMetadata: { symbol: null, decimals: null, name: null, logo: null },
    tokenPrices: [{ currency: 'usd', value: '2423.36', lastUpdatedAt: '2026-08-22T14:00:00Z' }],
  },
  {
    address: WALLET.toLowerCase(),
    network: 'eth-mainnet',
    tokenAddress: USDC,
    tokenBalance: '0x' + (12_500_000_000n).toString(16),
    tokenMetadata: { symbol: 'USDC', decimals: 6, name: 'USD Coin', logo: null },
    tokenPrices: [],
  },
  {
    address: WALLET.toLowerCase(),
    network: 'eth-mainnet',
    tokenAddress: WETH,
    tokenBalance: '0x' + (1_461_900_000_000_000_000n).toString(16),
    tokenMetadata: { symbol: 'WETH', decimals: 18, name: 'Wrapped Ether', logo: null },
    tokenPrices: [],
  },
  {
    // A scam airdrop calling itself USDC. Symbol-matching would price this at
    // $1 each and add $999,000 of imaginary value to the total.
    address: WALLET.toLowerCase(),
    network: 'eth-mainnet',
    tokenAddress: SCAM,
    tokenBalance: '0x' + (999_000_000_000_000_000_000_000n).toString(16),
    tokenMetadata: { symbol: 'USDC', decimals: 18, name: 'USD Coin', logo: null },
    tokenPrices: [],
  },
];

/** Prices keyed by (network, contract) — the scam token gets no price. */
const prices: PriceMap = new Map([
  [priceKey('eth-mainnet', USDC), { kind: 'priced', usd: 1.0, lastUpdatedAt: null }],
  [priceKey('eth-mainnet', WETH), { kind: 'priced', usd: 2423.36, lastUpdatedAt: null }],
  [
    priceKey('eth-mainnet', SCAM),
    { kind: 'token-error', reason: `Price not found for eth-mainnet:${SCAM}` },
  ],
] as const satisfies readonly (readonly [string, PriceMap extends Map<string, infer V> ? V : never])[]);

function valuationFrom(raw: unknown) {
  const parsed = parsePortfolioResponse(raw);
  return buildValuation({
    addresses: [WALLET],
    tokens: parsed.tokens,
    prices,
    partialErrors: parsed.partialErrors,
    networksRequested: NETWORKS,
    pagesFetched: 1,
  });
}

// ── Scenario A: every chain reported ──
const healthy = valuationFrom({ data: { tokens: TOKENS, pageKey: null } });

// ── Scenario B: identical data, but two chains failed. HTTP 200 either way. ──
const degraded = valuationFrom({
  data: { tokens: TOKENS, pageKey: null },
  error: {
    partialErrors: [
      { network: 'base-mainnet', message: 'Internal error fetching data for base-mainnet' },
      { network: 'opt-mainnet', message: 'upstream request timed out' },
    ],
  },
});

const bar = (label: string) => `\n${'▀'.repeat(74)}\n  ${label}\n${'▀'.repeat(74)}\n`;

process.stdout.write(bar('SCENARIO A — every network reported successfully'));
process.stdout.write(renderValuation(healthy));

process.stdout.write(bar('SCENARIO B — identical holdings, two networks failed (still HTTP 200)'));
process.stdout.write(renderValuation(degraded));

process.stdout.write(bar('THE POINT'));
process.stdout.write(
  `  Both scenarios contain exactly the same holdings and produce exactly the\n` +
    `  same number:\n\n` +
    `      scenario A total : $${healthy.totalUsd.toFixed(2)}\n` +
    `      scenario B total : $${degraded.totalUsd.toFixed(2)}\n` +
    `      identical        : ${healthy.totalUsd === degraded.totalUsd}\n\n` +
    `  A tool that only reads response.data would render these two identically\n` +
    `  and the person would never know two chains were missing.\n\n` +
    `      scenario A complete : ${healthy.complete}   → exit 0\n` +
    `      scenario B complete : ${degraded.complete}   → exit 3\n\n` +
    `  Note also that the scam token calling itself "USDC" is excluded rather\n` +
    `  than priced at $1 — it has ${(999_000).toLocaleString('en-US')} units, which symbol-matching\n` +
    `  would have added to the total as imaginary value.\n\n`,
);
