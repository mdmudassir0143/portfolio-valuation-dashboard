/**
 * The HTTP layer shared by the Portfolio and Prices clients.
 *
 * A wallet with holdings across ten chains produces hundreds of sequential
 * requests. At that volume two things reliably go wrong, neither of them the
 * API's fault:
 *
 *   - the provider rate-limits (429)
 *   - the local machine runs out of sockets or hammers its DNS resolver,
 *     surfacing as a bare `TypeError: fetch failed`, EADDRNOTAVAIL or ENOTFOUND
 *
 * Both are transient. Neither is a reason to abandon a half-finished
 * valuation and report a number that is quietly too low — which is precisely
 * the failure this tool exists to prevent, so it must not commit it itself.
 */

/** Pause between requests, to avoid exhausting local sockets. */
export const DEFAULT_REQUEST_DELAY_MS = 80;

export interface PostJsonOptions {
  attempts?: number;
  delayMs?: number;
  onRetry?: (attempt: number, reason: string) => void;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * POST JSON and return the parsed body, retrying transient failures.
 *
 * Throws `HttpError` for a non-retryable HTTP status so the caller can decide
 * how to degrade — for pricing, that means marking holdings unpriced rather
 * than valuing them at zero.
 */
export async function postJson(
  url: string,
  body: unknown,
  options: PostJsonOptions = {},
): Promise<unknown> {
  const attempts = options.attempts ?? 8;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (response.status === 429 || response.status >= 500) {
        // Retryable status — fall through to the backoff below.
        throw new HttpError(
          `HTTP ${response.status}`,
          response.status,
          await response.text().catch(() => ''),
        );
      }

      if (!response.ok) {
        // 4xx other than 429 will fail identically forever. Surface it.
        throw new HttpError(
          `HTTP ${response.status} ${response.statusText}`,
          response.status,
          await response.text().catch(() => ''),
        );
      }

      return await response.json();
    } catch (error) {
      lastError = error;

      if (!isRetryable(error) || attempt === attempts - 1) throw error;

      options.onRetry?.(attempt + 1, describe(error));

      // 0.5s, 1s, 2s, 4s, 8s, 15s, 15s — capped, with jitter so parallel
      // callers do not retry in lockstep. Patient enough to ride out a DNS or
      // rate-limit blip rather than abandoning a half-finished valuation.
      const backoff = Math.min(500 * 2 ** attempt, 15_000) + Math.random() * 250;
      await sleep(backoff);
    }
  }

  throw lastError;
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof HttpError) {
    return error.status === 429 || error.status >= 500;
  }

  const candidate = error as { code?: unknown; cause?: { code?: unknown }; message?: string } | null;

  const codes = [candidate?.code, candidate?.cause?.code].map((c) => String(c ?? '').toUpperCase());
  if (
    codes.some((code) =>
      [
        'EADDRNOTAVAIL',
        'ECONNRESET',
        'ECONNREFUSED',
        'ENOTFOUND',
        'EAI_AGAIN',
        'EMFILE',
        'ETIMEDOUT',
        'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_SOCKET',
      ].includes(code),
    )
  ) {
    return true;
  }

  const message = String(candidate?.message ?? '').toLowerCase();
  return (
    // undici's generic wrapper for every transport failure.
    message.includes('fetch failed') ||
    message.includes('rate limit') ||
    message.includes('timeout') ||
    message.includes('socket') ||
    message.includes('network')
  );
}

function describe(error: unknown): string {
  const candidate = error as { cause?: { code?: unknown }; message?: string } | null;
  const code = candidate?.cause?.code;
  return code ? `${candidate?.message} (${String(code)})` : String(candidate?.message ?? error);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
