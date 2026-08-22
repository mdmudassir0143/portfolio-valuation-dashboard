#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { getAddress, isAddress } from 'ethers';
import { ConfigError, loadApiKey, redact } from './config.js';
import { renderJson, renderValuation } from './format.js';
import { NETWORK_IDS, parseNetworks } from './networks.js';
import { fetchPortfolio } from './portfolio.js';
import { fetchPrices, inlinePrice, priceKey as priceKeyOf, type PriceKey } from './prices.js';
import { buildValuation } from './valuation.js';

const USAGE = `
portfolio-valuation-dashboard — one trustworthy multi-chain total

USAGE
  npm start -- <address> [more addresses…] [options]

OPTIONS
  --networks <list>   Comma-separated networks to query
                      (default: all ${NETWORK_IDS.length} — ${NETWORK_IDS.slice(0, 3).join(', ')}, …)
  --json              Emit JSON instead of the report
  --max-price-lookups <n>
                      Cap explicit price lookups           (default: 1000)
                      Most holdings are priced inline by the Portfolio API;
                      this bounds the extra calls for the rest. Anything
                      skipped is reported as unpriced, never as $0.
  -h, --help          Show this message

EXAMPLES
  npm start -- 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045
  npm start -- 0xd8dA…6045 --networks eth-mainnet,base-mainnet
  npm start -- 0xd8dA…6045 --json > portfolio.json

EXIT CODES
  0  complete — every requested network reported successfully
  3  INCOMPLETE — at least one network failed; the total is a lower bound
  2  bad input or missing config
  1  unexpected error

Requires ALCHEMY_API_KEY in .env (see .env.example).
`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: {
      networks: { type: 'string' },
      'max-price-lookups': { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help || positionals.length === 0) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 2;
  }

  // ── Validate every address locally, before any API call ──
  const addresses: string[] = [];
  for (const input of positionals) {
    if (!isAddress(input)) {
      process.stderr.write(`\nInvalid address: "${input}" is not a well-formed Ethereum address.\n\n`);
      return 2;
    }
    addresses.push(getAddress(input));
  }

  let networks: readonly string[] = NETWORK_IDS;
  if (values.networks !== undefined) {
    try {
      networks = parseNetworks(values.networks);
    } catch (error) {
      process.stderr.write(`\n${(error as Error).message}\n\n`);
      return 2;
    }
  }

  const maxPriceLookups =
    values['max-price-lookups'] === undefined ? 1000 : Number(values['max-price-lookups']);
  if (!Number.isInteger(maxPriceLookups) || maxPriceLookups < 0) {
    process.stderr.write('\n--max-price-lookups must be a non-negative integer.\n\n');
    return 2;
  }

  const apiKey = loadApiKey();

  process.stderr.write(
    `Fetching balances for ${addresses.length} address${addresses.length === 1 ? '' : 'es'} ` +
      `across ${networks.length} networks in one fan-out request…\n`,
  );

  const portfolio = await fetchPortfolio({
    apiKey,
    addresses,
    networks,
    onPage: (page, count) => process.stderr.write(`  page ${page}: ${count} token records\n`),
  });

  if (portfolio.partialErrors.length > 0) {
    process.stderr.write(
      `\n  ⚠  ${portfolio.partialErrors.length} network(s) reported a partial failure — ` +
        `their holdings are missing from this data.\n`,
    );
  }

  // Price every held ERC-20 by (network, contract address).
  //
  // `withPrices: true` already returns a per-record price for most tokens, and
  // that price is itself scoped to that contract on that network. Only tokens
  // WITHOUT one need an explicit Prices API lookup — which keeps a wallet
  // holding thousands of spam airdrops from generating thousands of needless
  // requests. Native tokens have no contract to look up and use the inline
  // price only.
  const priceKeys: PriceKey[] = [];
  const seen = new Set<string>();
  let inlinePriced = 0;

  for (const token of portfolio.tokens) {
    if (token.tokenAddress === null) continue;
    if (BigInt(token.tokenBalance || '0x0') === 0n) continue;

    if (inlinePrice(token.tokenPrices)) {
      inlinePriced += 1;
      continue;
    }

    const composite = `${token.network}:${token.tokenAddress.toLowerCase()}`;
    if (seen.has(composite)) continue;
    seen.add(composite);
    priceKeys.push({ network: token.network, address: token.tokenAddress });
  }

  // Cap the explicit lookups. Anything beyond the cap had no inline price
  // either, so it stays unpriced — and is reported as such, never as $0.
  const lookups = priceKeys.slice(0, maxPriceLookups);
  const skipped = priceKeys.length - lookups.length;

  process.stderr.write(
    `${inlinePriced} holdings priced inline; ` +
      `looking up ${lookups.length} more (network, contract) pair${lookups.length === 1 ? '' : 's'}` +
      `${skipped > 0 ? `, skipping ${skipped} over the --max-price-lookups cap` : ''}…\n`,
  );

  const prices = await fetchPrices({
    apiKey,
    keys: lookups,
    onBatch: (done, total) => {
      if (total > 4 && done % 5 === 0) process.stderr.write(`  price batch ${done}/${total}\n`);
    },
  });

  // Record the skipped ones explicitly, so they are excluded and visible
  // rather than quietly absent from the map.
  for (const key of priceKeys.slice(maxPriceLookups)) {
    prices.set(priceKeyOf(key.network, key.address), {
      kind: 'no-price',
      reason: 'skipped — over the --max-price-lookups cap',
    });
  }

  const valuation = buildValuation({
    addresses,
    tokens: portfolio.tokens,
    prices,
    partialErrors: portfolio.partialErrors,
    networksRequested: networks,
    pagesFetched: portfolio.pagesFetched,
  });

  process.stdout.write(
    values.json ? `${renderJson(valuation)}\n` : renderValuation(valuation),
  );

  // A non-zero exit means the number must not be consumed as authoritative.
  return valuation.complete ? 0 : 3;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof ConfigError) {
      process.stderr.write(`\n${error.message}\n\n`);
      process.exitCode = 2;
      return;
    }
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`\nUnexpected error:\n${redact(message)}\n\n`);
    process.exitCode = 1;
  });
