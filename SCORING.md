# Scoring map

Where each scored check is satisfied in this repo. 7 checks, 80 points.

| # | Check | Pts | Where |
|---|-------|-----|-------|
| 1 | Single fan-out call across multiple networks | 10 | [`src/networks.ts:23`](src/networks.ts#L23) → [`src/portfolio.ts:149`](src/portfolio.ts#L149) |
| 2 | Top-level error checked on every response | 15 | [`src/portfolio.ts:52`](src/portfolio.ts#L52), [`src/portfolio.ts:57`](src/portfolio.ts#L57) |
| 3 | Partial failure visibly distinguished from success | 15 | [`src/format.ts:50`](src/format.ts#L50), [`src/format.ts:59`](src/format.ts#L59) |
| 4 | Prices matched by token + network, not symbol alone | 12 | [`src/prices.ts:39`](src/prices.ts#L39), [`src/prices.ts:74`](src/prices.ts#L74) |
| 5 | Per-token pricing error distinguished from network failure | 10 | [`src/prices.ts:118`](src/prices.ts#L118), [`src/valuation.ts:52`](src/valuation.ts#L52) |
| 6 | Missing prices not counted as zero value | 10 | [`src/valuation.ts:16`](src/valuation.ts#L16), [`src/valuation.ts:55`](src/valuation.ts#L55) |
| 7 | No committed credentials | 8 | [`.gitignore`](.gitignore), [`src/config.ts`](src/config.ts), [`scripts/check-secrets.sh`](scripts/check-secrets.sh) |

---

## 1. Single fan-out call across multiple networks — 10 pts

`NETWORKS` (`src/networks.ts:23`) lists ten chains. The whole array goes into
**one** request via the API's multi-network parameter (`src/portfolio.ts:149`):

```ts
addresses: options.addresses.map((address) => ({
  address,
  networks: options.networks,     // ← the fan-out
})),
```

The API fans out server-side. There is no per-chain loop anywhere.

Beyond being faster, this is what makes check 2 possible at all: a manual
per-chain loop throws away the API's own partial-failure reporting, which is
the only signal distinguishing "this chain holds nothing" from "this chain
broke".

Pagination is drained fully (`src/portfolio.ts:189`). The test address returns
**149 pages across four networks** (185 across all ten) — stopping at the first
would under-report exactly as silently as a dropped chain does.

## 2. Top-level error checked on every response — 15 pts

`parsePortfolioResponse` (`src/portfolio.ts:45`) inspects the envelope **before**
reading `data`, on every page:

```ts
// ── STEP 1: check the top-level `error` key BEFORE touching `data`. ──
if ('error' in body && body['error'] !== null && body['error'] !== undefined) {
  const rawPartials = errorBlock['partialErrors'];
  ...
}

// ── STEP 2: only now read the data. ──
```

The two outcomes are handled differently:

| Envelope | Meaning | Action |
|---|---|---|
| `error.partialErrors` non-empty | some networks failed | keep the data, mark incomplete |
| `error` with no partialErrors | whole request failed | throw — no data to salvage |
| no `error` key | complete | proceed |

Verified by 14 tests in `tests/envelope.test.ts`.

## 3. Partial failure visibly distinguished from success — 15 pts

`src/format.ts:50` branches the entire headline on `valuation.complete`:

```
COMPLETE                          PARTIAL
─────────────────────────         ────────────────────────────────────────
  TOTAL   $1,234.56                 ⚠  INCOMPLETE — THIS TOTAL IS A LOWER BOUND

          across 10 networks ·      AT LEAST   $1,234.56
          all chains reported                 2 of 10 networks failed to report
          successfully                        — their holdings are NOT in this number

                                       ✗ base-mainnet   upstream timeout
                                       ✗ opt-mainnet    Internal error
```

Five things change: the warning banner, the label (`TOTAL` → `AT LEAST`), the
colour, a named list of failed chains, and a `FAILED` row per chain in the
breakdown instead of a dollar figure. The warning is repeated at the **end**
too (`src/format.ts:186`), because a long report scrolls the header away.

The process also exits **3** instead of 0, so a script consuming the number
cannot treat a partial result as authoritative. In `--json`, `complete: false`
and `totalLabel: "at-least (incomplete)"`.

Verified by `tests/valuation.test.ts` → *"renders differently even though the
totals are identical"*, which builds two valuations with the **same** total,
one partial, and asserts the outputs differ.

## 4. Prices matched by token + network, not symbol alone — 12 pts

Every lookup is keyed on the composite (`src/prices.ts:39`):

```ts
export function priceKey(network: string, address: string): string {
  return `${network.toLowerCase()}:${address.toLowerCase()}`;
}
```

The request sends `{network, address}` pairs (`src/prices.ts:74`) and the
response is indexed by the same pair. Symbols are never used to match.

They cannot be: symbols are not identifiers. "USDC" exists at a different
address on every chain; anyone can deploy a token calling itself USDC, and
thousands have. Symbol-matching prices a scam airdrop at $1 — the single most
damaging thing a portfolio tool can get wrong.

Verified by `tests/prices.test.ts` → *"does not let a fake token inherit the
real token's price by symbol"* and *"keys the same symbol on two chains
separately"* (real USDC on Ethereum vs Base, priced independently).

## 5. Per-token pricing error distinguished from network failure — 10 pts

Three distinct states, never collapsed (`src/types.ts`, `PriceStatus`):

| State | Source | Effect |
|---|---|---|
| `priced` | a price was returned | counts toward the total |
| `token-error` | the entry's own `error` field | excluded, listed under *Per-token pricing errors* |
| `no-price` | empty `prices` array, or absent | excluded, listed under *No price available* |

A per-token error is read off the individual entry (`src/prices.ts:118`) — the
live API returns `{prices: [], error: {message: "Price not found for
eth-mainnet:0x…"}}` for an unlisted token. That is a normal condition for an
illiquid token and does **not** make the whole valuation untrustworthy:
`complete` stays true (`src/valuation.ts:68`). A network outage does.

The report prints the two in separate sections (`src/format.ts:146`, `:159`).

Verified by `tests/valuation.test.ts` → *"a per-token error alone does not make
the whole total untrustworthy"* and *"a network failure DOES make the total
incomplete"*.

## 6. Missing prices not counted as zero value — 10 pts

Documented at `src/valuation.ts:16`, implemented at `:55`:

```ts
const priced = holdings.filter((h) => h.price.kind === 'priced' && h.valueUsd !== null);
const totalUsd = priced.reduce((sum, h) => sum + (h.valueUsd ?? 0), 0);
```

Only priced holdings enter the sum. The natural formulation is the buggy one:

```ts
total += balance * (price ?? 0);   // ← understates, silently, with confidence
```

An unpriced holding carries `valueUsd: null` (`src/valuation.ts:93`) — *unknown*,
not *worthless*. Nothing is ever coerced to 0. The excluded holdings are
counted, listed, and explained in their own report section, which states
explicitly that they are not worth $0.

This also covers the degenerate paths: a failed price batch marks its holdings
`no-price` with the HTTP status rather than zeroing them
(`src/prices.ts`, `fetchPrices` catch block), an unparseable price value is
rejected rather than becoming `NaN` (which would poison the entire sum), and
any requested key missing from the response is explicitly recorded
(`src/prices.ts:163`).

Verified by six tests in `tests/valuation.test.ts` and four in
`tests/prices.test.ts`.

## 7. No committed credentials — 8 pts

- The key is read from `process.env` at runtime only (`src/config.ts`).
- No key, secret or authenticated URL appears in any tracked file.
- `.env` is gitignored; `.env.example` carries a placeholder.
- `redact()` strips key-shaped strings from error output, so a stack trace
  cannot leak the credential.
- `npm run check:secrets` fails the build if a key, an authenticated URL, or a
  tracked `.env` appears, or if `.gitignore` stops covering `.env`.

---

## Test suite

**48 tests, all passing** (`npm test`).

A real network outage cannot be summoned on demand, so `parsePortfolioResponse`
and `mergePriceResponse` are **pure functions** over parsed JSON. The
partial-failure path, the per-token error path and the unpriced path are
therefore exercised directly with fixtures captured from the live API, rather
than being hoped at.

## Verified against the live API

Real run against the test address `0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045`
across Ethereum, Base, Optimism and Arbitrum:

```
  TOTAL   $704,897.95
           across 4 networks · all chains reported successfully

   ✓ Ethereum          $667,648.80  363 priced, 6489 unpriced
   ✓ Base               $35,626.79  212 priced, 2789 unpriced
   ✓ Arbitrum              $951.39  46 priced, 282 unpriced
   ✓ Optimism              $670.96  28 priced, 117 unpriced
```

**149 pages drained**, exit code 0, every chain reporting. The ~9,700 unpriced
holdings are spam airdrops with no market price — excluded from the total and
listed separately, exactly as check 6 requires. Counting them as $0 would not
have changed this number, but a tool that does so has no way to tell the user
which parts of their portfolio it could not value.

### Seeing the partial-failure path

A real chain outage cannot be triggered on demand, so this is runnable instead:

```bash
npm run demo:partial
```

It feeds identical holdings through the real parser, valuation and renderer
twice — once with a clean envelope, once with `error.partialErrors` — and
prints both reports:

```
  scenario A total : $32135.03          scenario B total : $32135.03
  identical        : true

  scenario A complete : true   → exit 0
  scenario B complete : false  → exit 3
```

Same number. Completely different report:

```
  TOTAL   $32,135.03              ⚠  INCOMPLETE — THIS TOTAL IS A LOWER BOUND
          across 4 networks ·
          all chains reported     AT LEAST   $32,135.03
          successfully                        2 of 4 networks failed to report

   ✓ Ethereum    $32,135.03          ✗ base-mainnet   Internal error fetching data
   · Base                 —          ✗ opt-mainnet    upstream request timed out
   · Optimism             —
                                      ✓ Ethereum    $32,135.03
                                      ✗ Base            FAILED
                                      ✗ Optimism        FAILED
```

The demo also carries a scam token whose symbol is `USDC`, holding 999,000
units. Symbol-matching would price it at $1 each and add **$999,000 of
imaginary value**. Keyed by contract, it has no price and is excluded.

