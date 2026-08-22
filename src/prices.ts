import { DEFAULT_REQUEST_DELAY_MS, HttpError, postJson, sleep } from './http.js';
import type { PriceStatus } from './types.js';

/**
 * Pricing holdings.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  A PRICE BELONGS TO A CONTRACT ON A CHAIN, NOT TO A SYMBOL
 * ─────────────────────────────────────────────────────────────────────────
 * Symbols are not identifiers. They are not unique, not registered, and not
 * verified:
 *
 *   - "USDC" exists on every chain at a different address, and the bridged
 *     variants are genuinely different tokens.
 *   - Anyone can deploy a token called "USDC". Thousands have.
 *   - The same symbol can be a $1 stablecoin on one chain and a worthless
 *     scam token on another.
 *
 * Matching a holding's price by symbol therefore prices the wrong asset — and
 * does so most dramatically for scam tokens airdropped into a wallet, which is
 * precisely the case a portfolio tool must not get wrong.
 *
 * So every lookup is keyed on `network + contract address`, end to end: the
 * request sends {network, address} pairs, and the response is indexed by the
 * same pair.
 */

const PRICES_ENDPOINT = 'https://api.g.alchemy.com/prices/v1';

/** Max {network, address} pairs per request. */
const PRICE_BATCH_SIZE = 25;

export interface PriceKey {
  network: string;
  address: string;
}

/** Composite key: a price is only valid for this contract on this chain. */
export function priceKey(network: string, address: string): string {
  return `${network.toLowerCase()}:${address.toLowerCase()}`;
}

export type PriceMap = Map<string, PriceStatus>;

export interface FetchPricesOptions {
  apiKey: string;
  keys: PriceKey[];
  currency?: string;
  onBatch?: (done: number, total: number) => void;
}

/**
 * Fetch prices for a set of (network, contract) pairs.
 *
 * Returns a map keyed by `network:address`. Entries the API could not price
 * are present with an explicit non-priced status — absence and "no price" are
 * deliberately distinguishable, so a lookup miss can never be quietly read as
 * zero.
 */
export async function fetchPrices(options: FetchPricesOptions): Promise<PriceMap> {
  const currency = options.currency ?? 'usd';
  const url = `${PRICES_ENDPOINT}/${options.apiKey}/tokens/by-address`;

  const result: PriceMap = new Map();
  const batchCount = Math.ceil(options.keys.length / PRICE_BATCH_SIZE);

  for (let i = 0; i < options.keys.length; i += PRICE_BATCH_SIZE) {
    const batch = options.keys.slice(i, i + PRICE_BATCH_SIZE);
    if (batch.length === 0) continue;

    try {
      const raw = await postJson(url, {
        // Contract address AND network on every entry.
        addresses: batch.map((k) => ({ network: k.network, address: k.address })),
      });
      mergePriceResponse(raw, batch, currency, result);
    } catch (error) {
      // A failed batch must NOT silently zero out its holdings. Mark each one
      // unpriced with the reason so it is excluded from the total and shown.
      const reason =
        error instanceof HttpError
          ? `price lookup failed (HTTP ${error.status})`
          : `price lookup failed (${String((error as Error).message).slice(0, 60)})`;

      for (const key of batch) {
        result.set(priceKey(key.network, key.address), { kind: 'no-price', reason });
      }
    }

    options.onBatch?.(Math.floor(i / PRICE_BATCH_SIZE) + 1, batchCount);
    if (i + PRICE_BATCH_SIZE < options.keys.length) await sleep(DEFAULT_REQUEST_DELAY_MS);
  }

  return result;
}

/**
 * Fold one Prices API response into the map.
 *
 * Pure, so the per-token error path is directly testable.
 */
export function mergePriceResponse(
  raw: unknown,
  requested: PriceKey[],
  currency: string,
  into: PriceMap,
): PriceMap {
  const body = (raw ?? {}) as Record<string, unknown>;
  const entries = Array.isArray(body['data']) ? (body['data'] as Record<string, unknown>[]) : [];

  for (const entry of entries) {
    const network = typeof entry['network'] === 'string' ? entry['network'] : null;
    const address = typeof entry['address'] === 'string' ? entry['address'] : null;
    if (network === null || address === null) continue;

    const key = priceKey(network, address);

    // ── A PER-TOKEN error, not a network outage. ──
    // The API reports "Price not found for eth-mainnet:0x…" on the individual
    // entry, with `prices: []`. That is a normal, expected condition for an
    // illiquid or unlisted token — completely different from a chain being
    // down, and reported separately so one is never mistaken for the other.
    if (entry['error'] !== null && entry['error'] !== undefined) {
      const errorRecord = entry['error'] as Record<string, unknown>;
      into.set(key, {
        kind: 'token-error',
        reason:
          typeof errorRecord['message'] === 'string'
            ? errorRecord['message']
            : 'price unavailable for this token',
      });
      continue;
    }

    const prices = Array.isArray(entry['prices']) ? (entry['prices'] as Record<string, unknown>[]) : [];
    const match = prices.find(
      (p) => String(p['currency'] ?? '').toLowerCase() === currency.toLowerCase(),
    );

    if (!match) {
      into.set(key, { kind: 'no-price', reason: `no ${currency.toUpperCase()} price available` });
      continue;
    }

    const value = Number(match['value']);
    if (!Number.isFinite(value)) {
      into.set(key, { kind: 'no-price', reason: `unparseable price "${String(match['value'])}"` });
      continue;
    }

    into.set(key, {
      kind: 'priced',
      usd: value,
      lastUpdatedAt: typeof match['lastUpdatedAt'] === 'string' ? match['lastUpdatedAt'] : null,
    });
  }

  // Anything requested but absent from the response is explicitly unpriced —
  // never treated as zero, and never silently missing from the map.
  for (const key of requested) {
    const composite = priceKey(key.network, key.address);
    if (!into.has(composite)) {
      into.set(composite, { kind: 'no-price', reason: 'not returned by the price API' });
    }
  }

  return into;
}

/**
 * Read the price the Portfolio API already inlined on a token record.
 *
 * `withPrices: true` returns a `tokenPrices` array per holding, which saves a
 * round trip. It is still a per-(network, contract) price — the entry belongs
 * to that specific token record — so it is used only as a fallback for
 * holdings the dedicated Prices API did not cover.
 */
export function inlinePrice(
  tokenPrices: { currency: string; value: string; lastUpdatedAt: string }[] | null | undefined,
  currency = 'usd',
): PriceStatus | null {
  if (!Array.isArray(tokenPrices) || tokenPrices.length === 0) return null;

  const match = tokenPrices.find((p) => p.currency?.toLowerCase() === currency.toLowerCase());
  if (!match) return null;

  const value = Number(match.value);
  if (!Number.isFinite(value)) return null;

  return { kind: 'priced', usd: value, lastUpdatedAt: match.lastUpdatedAt ?? null };
}
