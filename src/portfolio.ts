import { DEFAULT_REQUEST_DELAY_MS, HttpError, postJson, sleep } from './http.js';
import type { PartialError, PortfolioResponse, RawToken } from './types.js';

/**
 * The Portfolio API: one fan-out request across many networks, and the
 * envelope inspection that decides whether the answer can be trusted.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  A FAILED NETWORK STILL RETURNS HTTP 200
 * ─────────────────────────────────────────────────────────────────────────
 * When one chain's backend is unavailable, the request does not fail. The
 * status is 200, the body parses, `data.tokens` is populated with every
 * network that DID work — and the broken one is simply absent.
 *
 * The only trace is a top-level `error.partialErrors` list, sitting alongside
 * `data`. Code that reads `response.data.tokens` and never looks at
 * `response.error` cannot tell a wallet that holds nothing on Base from a
 * wallet whose Base data failed to load. Both look like success. That is
 * exactly how a portfolio bot silently under-reports.
 *
 * So: the envelope is inspected BEFORE the data is used, every time.
 */

const PORTFOLIO_ENDPOINT = 'https://api.g.alchemy.com/data/v1';

export class PortfolioApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'PortfolioApiError';
  }
}

/**
 * Inspect a raw Portfolio API response body.
 *
 * A pure function taking parsed JSON, so the partial-failure path can be
 * tested directly — a real network outage cannot be summoned on demand.
 *
 * Throws on a fatal error (the whole request failed). Returns tokens plus any
 * partial errors otherwise.
 */
export function parsePortfolioResponse(raw: unknown): PortfolioResponse {
  if (raw === null || typeof raw !== 'object') {
    throw new PortfolioApiError('Portfolio API returned a non-object body.');
  }

  const body = raw as Record<string, unknown>;

  // ── STEP 1: check the top-level `error` key BEFORE touching `data`. ──
  // Its presence is what distinguishes a complete response from one that only
  // looks complete.
  const partialErrors: PartialError[] = [];

  if ('error' in body && body['error'] !== null && body['error'] !== undefined) {
    const errorBlock = body['error'] as Record<string, unknown>;
    const rawPartials = errorBlock['partialErrors'];

    if (Array.isArray(rawPartials) && rawPartials.length > 0) {
      // Some networks failed; the rest of the response is still usable, but
      // the result is now explicitly incomplete.
      for (const entry of rawPartials) {
        partialErrors.push(normalisePartialError(entry));
      }
    } else {
      // A top-level error with no partialErrors list means the entire request
      // failed. There is no usable data to salvage.
      const message =
        typeof errorBlock['message'] === 'string'
          ? errorBlock['message']
          : JSON.stringify(errorBlock);
      throw new PortfolioApiError(`Portfolio API error: ${message}`);
    }
  }

  // ── STEP 2: only now read the data. ──
  const data = body['data'];
  if (data === null || typeof data !== 'object') {
    throw new PortfolioApiError('Portfolio API response had no `data` object.');
  }

  const dataObject = data as Record<string, unknown>;
  const tokens = Array.isArray(dataObject['tokens']) ? (dataObject['tokens'] as RawToken[]) : [];
  const pageKey = typeof dataObject['pageKey'] === 'string' ? dataObject['pageKey'] : null;

  return { tokens, partialErrors, pageKey };
}

function normalisePartialError(entry: unknown): PartialError {
  if (entry === null || typeof entry !== 'object') {
    return { network: 'unknown', message: String(entry) };
  }

  const record = entry as Record<string, unknown>;
  return {
    network:
      typeof record['network'] === 'string'
        ? record['network']
        : typeof record['networkId'] === 'string'
          ? record['networkId']
          : 'unknown',
    message:
      typeof record['message'] === 'string'
        ? record['message']
        : typeof record['error'] === 'string'
          ? record['error']
          : 'network data unavailable',
  };
}

export interface FetchPortfolioOptions {
  apiKey: string;
  addresses: readonly string[];
  networks: readonly string[];
  onPage?: (page: number, tokenCount: number) => void;
  onRetry?: (attempt: number, reason: string) => void;
}

/**
 * Fetch every token balance for one address across many networks.
 *
 * A SINGLE request carries the whole `networks` array — the API fans out
 * server-side. Pagination is drained fully: a wallet with holdings across ten
 * chains exceeds one page easily, and stopping at the first page would
 * under-report the total exactly as silently as a dropped network would.
 */
export async function fetchPortfolio(
  options: FetchPortfolioOptions,
): Promise<PortfolioResponse & { pagesFetched: number }> {
  const url = `${PORTFOLIO_ENDPOINT}/${options.apiKey}/assets/tokens/by-address`;

  const tokens: RawToken[] = [];
  const partialErrors: PartialError[] = [];
  const seenPartialKeys = new Set<string>();

  let pageKey: string | null = null;
  let pages = 0;

  do {
    let raw: unknown;
    try {
      raw = await postJson(
        url,
        {
          // Every wallet x every network, in ONE request. The API fans out
          // server-side; this is the multi-network parameter doing the work.
          addresses: options.addresses.map((address) => ({
            address,
            networks: options.networks,
          })),
          withMetadata: true,
          withPrices: true,
          includeNativeTokens: true,
          ...(pageKey !== null ? { pageKey } : {}),
        },
        options.onRetry ? { onRetry: options.onRetry } : {},
      );
    } catch (error) {
      if (error instanceof HttpError) {
        throw new PortfolioApiError(
          `Portfolio API returned HTTP ${error.status}. ${error.body.slice(0, 200)}`,
          error.status,
        );
      }
      throw error;
    }

    const parsed = parsePortfolioResponse(raw);

    tokens.push(...parsed.tokens);
    pages += 1;

    // Partial errors can differ per page; collect the union, deduplicated.
    for (const partial of parsed.partialErrors) {
      const key = `${partial.network}:${partial.message}`;
      if (!seenPartialKeys.has(key)) {
        seenPartialKeys.add(key);
        partialErrors.push(partial);
      }
    }

    options.onPage?.(pages, parsed.tokens.length);
    pageKey = parsed.pageKey;

    // Breathe between pages so a long drain does not exhaust local sockets.
    if (pageKey !== null) await sleep(DEFAULT_REQUEST_DELAY_MS);
  } while (pageKey !== null);

  return { tokens, partialErrors, pageKey: null, pagesFetched: pages };
}
