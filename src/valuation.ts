import { networkInfo } from './networks.js';
import { inlinePrice, priceKey, type PriceMap } from './prices.js';
import type {
  Holding,
  NetworkBreakdown,
  PartialError,
  PriceStatus,
  RawToken,
  Valuation,
} from './types.js';

/**
 * Turning balances and prices into a number a person can rely on.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  A MISSING PRICE IS NOT A PRICE OF ZERO
 * ─────────────────────────────────────────────────────────────────────────
 * The natural way to write the sum is the wrong one:
 *
 *     total += balance * (price ?? 0);          // ← understates, silently
 *     total += holdings.reduce((s, h) => s + h.value, 0);   // ← same bug
 *
 * A token with no available price contributes 0 to that sum, and the result is
 * presented with the same confidence as a complete one. The person reading it
 * has no way to tell that a chunk of their portfolio was quietly valued at
 * nothing.
 *
 * So unpriced holdings are EXCLUDED from the total and counted separately, and
 * the report always says how many were left out.
 */

export interface BuildValuationInput {
  addresses: readonly string[];
  tokens: RawToken[];
  prices: PriceMap;
  partialErrors: PartialError[];
  networksRequested: readonly string[];
  pagesFetched: number;
  /** Hide dust and zero balances from the report. */
  minValueUsd?: number;
}

export function buildValuation(input: BuildValuationInput): Valuation {
  const holdings = input.tokens
    .map((token) => toHolding(token, input.prices))
    // Zero balances are noise, not information — a wallet that has never held
    // a token still gets a record for it.
    .filter((h) => h.rawBalance > 0n);

  const priced = holdings.filter((h) => h.price.kind === 'priced' && h.valueUsd !== null);
  const unpriced = holdings.filter((h) => h.price.kind === 'no-price');
  const tokenErrors = holdings.filter((h) => h.price.kind === 'token-error');

  // Only priced holdings contribute. Nothing else is coerced to 0 and added.
  const totalUsd = priced.reduce((sum, h) => sum + (h.valueUsd ?? 0), 0);

  const failedNetworks = input.partialErrors;
  const failedIds = new Set(failedNetworks.map((e) => e.network));

  const breakdown = buildBreakdown(holdings, input.networksRequested, failedNetworks);

  return {
    addresses: [...input.addresses],
    totalUsd,
    // The total is only "complete" if no network failed. Per-token pricing
    // gaps are reported separately and do not, on their own, make the whole
    // response untrustworthy — but a missing chain does.
    complete: failedIds.size === 0,
    networksRequested: [...input.networksRequested],
    failedNetworks,
    breakdown,
    holdings,
    unpriced,
    tokenErrors,
    pagesFetched: input.pagesFetched,
  };
}

function toHolding(token: RawToken, prices: PriceMap): Holding {
  const isNative = token.tokenAddress === null;
  const info = networkInfo(token.network);

  const decimals = isNative ? info.nativeDecimals : (token.tokenMetadata?.decimals ?? null);
  const symbol = isNative ? info.nativeSymbol : (token.tokenMetadata?.symbol ?? 'UNKNOWN');

  const rawBalance = parseHexBalance(token.tokenBalance);
  const balance = decimals === null ? null : scaleBalance(rawBalance, decimals);

  const price = resolvePrice(token, prices);

  // A value exists only when BOTH the balance and the price are known.
  // Either being unknown means no value — not a zero value.
  const valueUsd = price.kind === 'priced' && balance !== null ? balance * price.usd : null;

  return {
    network: token.network,
    tokenAddress: token.tokenAddress,
    symbol,
    name: token.tokenMetadata?.name ?? null,
    decimals,
    rawBalance,
    balance,
    isNative,
    price,
    valueUsd,
  };
}

/**
 * Resolve a holding's price.
 *
 * Order: an explicit per-token API error wins (it is the most specific
 * information available), then the dedicated Prices API lookup keyed by
 * network + contract, then the price the Portfolio API inlined on the record.
 */
function resolvePrice(token: RawToken, prices: PriceMap): PriceStatus {
  if (token.error) {
    return {
      kind: 'token-error',
      reason: token.error.message ?? 'the API reported an error for this token',
    };
  }

  if (token.tokenAddress !== null) {
    const looked = prices.get(priceKey(token.network, token.tokenAddress));
    if (looked && looked.kind === 'priced') return looked;

    const inline = inlinePrice(token.tokenPrices);
    if (inline) return inline;

    // Keep the specific reason from the lookup rather than a generic one.
    if (looked) return looked;

    return { kind: 'no-price', reason: 'no price available' };
  }

  // Native token: no contract address to look up, so the Portfolio API's
  // inlined price is the source.
  const inline = inlinePrice(token.tokenPrices);
  if (inline) return inline;

  return { kind: 'no-price', reason: 'no price available for the native token' };
}

function buildBreakdown(
  holdings: Holding[],
  networksRequested: readonly string[],
  failures: PartialError[],
): NetworkBreakdown[] {
  const failureByNetwork = new Map(failures.map((f) => [f.network, f.message]));
  const byNetwork = new Map<string, Holding[]>();

  for (const holding of holdings) {
    const list = byNetwork.get(holding.network) ?? [];
    list.push(holding);
    byNetwork.set(holding.network, list);
  }

  // Every requested network appears, including ones that failed and ones that
  // are genuinely empty — an absent row would be indistinguishable from zero.
  const allNetworks = new Set<string>([...networksRequested, ...byNetwork.keys()]);

  return [...allNetworks]
    .map((network) => {
      const list = byNetwork.get(network) ?? [];
      const failureMessage = failureByNetwork.get(network);

      const breakdown: NetworkBreakdown = {
        network,
        label: networkInfo(network).label,
        valueUsd: list.reduce((sum, h) => sum + (h.valueUsd ?? 0), 0),
        holdingCount: list.length,
        pricedCount: list.filter((h) => h.price.kind === 'priced').length,
        unpricedCount: list.filter((h) => h.price.kind !== 'priced').length,
        failed: failureMessage !== undefined,
      };

      if (failureMessage !== undefined) breakdown.failureMessage = failureMessage;
      return breakdown;
    })
    .sort((a, b) => b.valueUsd - a.valueUsd);
}

/** Alchemy returns balances as 0x-prefixed 32-byte hex. */
export function parseHexBalance(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/**
 * Scale an integer balance by its decimals.
 *
 * Done via string manipulation rather than `Number(raw) / 10 ** decimals`,
 * because a token balance routinely exceeds Number.MAX_SAFE_INTEGER and the
 * naive division loses precision before the division even happens.
 */
export function scaleBalance(raw: bigint, decimals: number): number {
  if (decimals === 0) return Number(raw);

  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const remainder = raw % divisor;

  const fraction = remainder.toString().padStart(decimals, '0').slice(0, 18);
  return Number(`${whole}.${fraction}`);
}
