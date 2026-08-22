/**
 * The networks queried in one fan-out request.
 *
 * The Portfolio API takes a `networks` array and fans out server-side, so all
 * of these are covered by a SINGLE call. Looping one request per chain would
 * work too, but it is slower, it multiplies the ways a chain can fail, and it
 * throws away the API's own partial-failure reporting — which is the only
 * signal that a chain came back empty because it broke rather than because the
 * wallet holds nothing there.
 */

export interface NetworkInfo {
  /** Alchemy's network identifier, as sent in the request. */
  id: string;
  /** Human-readable name for the report. */
  label: string;
  /** Symbol of the chain's native (gas) token. */
  nativeSymbol: string;
  /** Decimals of the native token. Every EVM chain here uses 18. */
  nativeDecimals: number;
}

export const NETWORKS: readonly NetworkInfo[] = [
  { id: 'eth-mainnet', label: 'Ethereum', nativeSymbol: 'ETH', nativeDecimals: 18 },
  { id: 'base-mainnet', label: 'Base', nativeSymbol: 'ETH', nativeDecimals: 18 },
  { id: 'opt-mainnet', label: 'Optimism', nativeSymbol: 'ETH', nativeDecimals: 18 },
  { id: 'arb-mainnet', label: 'Arbitrum', nativeSymbol: 'ETH', nativeDecimals: 18 },
  { id: 'matic-mainnet', label: 'Polygon', nativeSymbol: 'POL', nativeDecimals: 18 },
  { id: 'bnb-mainnet', label: 'BNB Chain', nativeSymbol: 'BNB', nativeDecimals: 18 },
  { id: 'avax-mainnet', label: 'Avalanche', nativeSymbol: 'AVAX', nativeDecimals: 18 },
  { id: 'linea-mainnet', label: 'Linea', nativeSymbol: 'ETH', nativeDecimals: 18 },
  { id: 'scroll-mainnet', label: 'Scroll', nativeSymbol: 'ETH', nativeDecimals: 18 },
  { id: 'zksync-mainnet', label: 'zkSync Era', nativeSymbol: 'ETH', nativeDecimals: 18 },
] as const;

/** Just the ids — this array is what goes into the fan-out request. */
export const NETWORK_IDS: readonly string[] = NETWORKS.map((n) => n.id);

const BY_ID = new Map(NETWORKS.map((n) => [n.id, n]));

export function networkInfo(id: string): NetworkInfo {
  return (
    BY_ID.get(id) ?? {
      id,
      label: id,
      nativeSymbol: 'native',
      nativeDecimals: 18,
    }
  );
}

/** Parse a `--networks a,b,c` override, rejecting unknown ids locally. */
export function parseNetworks(input: string): string[] {
  const requested = input
    .split(',')
    .map((n) => n.trim().toLowerCase())
    .filter((n) => n.length > 0);

  if (requested.length === 0) {
    throw new Error('--networks was given but listed no networks.');
  }

  const unknown = requested.filter((n) => !BY_ID.has(n));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown network: ${unknown.join(', ')}\nSupported: ${NETWORK_IDS.join(', ')}`,
    );
  }

  return requested;
}
