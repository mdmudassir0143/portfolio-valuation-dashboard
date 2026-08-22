/** A price quote from the Prices API. */
export interface TokenPrice {
  currency: string;
  value: string;
  lastUpdatedAt: string;
}

/** One token balance as returned by the Portfolio API. */
export interface RawToken {
  address: string;
  network: string;
  /** null for the chain's native token (ETH, BNB, …). */
  tokenAddress: string | null;
  tokenBalance: string;
  tokenMetadata?: {
    symbol: string | null;
    decimals: number | null;
    name: string | null;
    logo: string | null;
  } | null;
  tokenPrices?: TokenPrice[] | null;
  /** Per-token failure, distinct from a whole-network failure. */
  error?: { message?: string } | null;
}

/**
 * A single network failing inside an otherwise-successful HTTP 200 response.
 *
 * This is the shape that makes this problem what it is: the request succeeds,
 * the body parses, `data.tokens` is populated — and one chain is just quietly
 * absent unless this list is read.
 */
export interface PartialError {
  network: string;
  message: string;
}

/** The Portfolio API response, after the envelope has been inspected. */
export interface PortfolioResponse {
  tokens: RawToken[];
  partialErrors: PartialError[];
  pageKey: string | null;
}

/** Why a holding has no price. The two cases are reported differently. */
export type PriceStatus =
  | { kind: 'priced'; usd: number; lastUpdatedAt: string | null }
  | { kind: 'no-price'; reason: string }
  | { kind: 'token-error'; reason: string };

/** A holding after balance decoding and price resolution. */
export interface Holding {
  network: string;
  tokenAddress: string | null;
  symbol: string;
  name: string | null;
  decimals: number | null;
  /** Raw on-chain integer balance. */
  rawBalance: bigint;
  /** Human-scale balance, or null when decimals are unknown. */
  balance: number | null;
  isNative: boolean;
  price: PriceStatus;
  /** balance × price, only when both are known. */
  valueUsd: number | null;
}

export interface NetworkBreakdown {
  network: string;
  label: string;
  /** Total for holdings that could be priced. */
  valueUsd: number;
  holdingCount: number;
  pricedCount: number;
  unpricedCount: number;
  /** True when this network's data did not come back cleanly. */
  failed: boolean;
  failureMessage?: string;
}

/**
 * The finished valuation.
 *
 * `complete` is the field that matters: false means the total is a lower
 * bound, not the answer, and every renderer must say so.
 */
export interface Valuation {
  /** Every wallet included in this valuation. */
  addresses: string[];
  totalUsd: number;
  complete: boolean;
  networksRequested: string[];
  failedNetworks: PartialError[];
  breakdown: NetworkBreakdown[];
  holdings: Holding[];
  /** Holdings excluded from the total because they had no usable price. */
  unpriced: Holding[];
  /** Holdings the API reported a per-token error for. */
  tokenErrors: Holding[];
  pagesFetched: number;
}
