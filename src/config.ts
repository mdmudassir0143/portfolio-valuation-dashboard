import 'dotenv/config';

/**
 * Credential loading.
 *
 * The API key is read from the environment at runtime and never appears in
 * source. `.env` is gitignored; `.env.example` ships a placeholder so a fresh
 * clone knows what to set. Nothing in this repo contains a real key or an
 * authenticated Alchemy URL.
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const PLACEHOLDER_VALUES = new Set([
  'your_alchemy_api_key_here',
  'your-api-key',
  'changeme',
]);

export function loadApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env['ALCHEMY_API_KEY'];

  if (raw === undefined || raw.trim().length === 0) {
    throw new ConfigError(
      'ALCHEMY_API_KEY is not set.\n\n' +
        '  1. cp .env.example .env\n' +
        '  2. Put your key in .env (get one free at https://dashboard.alchemy.com)\n\n' +
        '.env is gitignored, so your key stays out of version control.',
    );
  }

  const key = raw.trim();

  if (PLACEHOLDER_VALUES.has(key.toLowerCase())) {
    throw new ConfigError(
      'ALCHEMY_API_KEY is still set to the placeholder from .env.example. ' +
        'Replace it with a real key from https://dashboard.alchemy.com',
    );
  }

  return key;
}

/**
 * Redact anything key-shaped before it reaches a log line or an error message,
 * so a stack trace can never leak the credential into a terminal or CI log.
 */
export function redact(text: string): string {
  return (
    text
      // URL form FIRST, so the embedded key is consumed in a single pass.
      // Redacting the bare key first would leave `alch_` behind for this
      // pattern to match again, producing a doubled marker.
      .replace(/(g\.alchemy\.com\/v2\/)[A-Za-z0-9_-]+/g, '$1***REDACTED***')
      // Any key appearing outside a URL.
      .replace(/alch_[A-Za-z0-9_-]+/g, 'alch_***REDACTED***')
  );
}
