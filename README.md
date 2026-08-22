# portfolio-valuation-dashboard

One trustworthy number for "what is all of this worth right now", across every
chain a wallet holds tokens on — and a loud, unmissable warning when that
number is incomplete.

Built for the bot that quietly returned a lower total the one time a chain's
RPC hiccuped, and nobody noticed because it didn't error.

```
══════════════════════════════════════════════════════════════════════════
  Multi-Chain Portfolio
  0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045
══════════════════════════════════════════════════════════════════════════

  TOTAL   $709,517.99
           across 10 networks · all chains reported successfully

  ──────────────────────────────────────────────────────────────────────────

  By network

   ✓ Ethereum          $667,306.09  363 priced, 6490 unpriced
   ✓ Base               $35,984.15  212 priced, 2789 unpriced
   ✓ BNB Chain           $4,291.78  98 priced, 1937 unpriced
   ✓ Arbitrum              $953.60  46 priced, 282 unpriced
   ✓ Optimism              $673.64  28 priced, 117 unpriced
   ✓ Scroll                $173.16  4 priced, 74 unpriced
   ✓ Polygon                $63.77  1 priced, 933 unpriced
   ✓ zkSync Era             $41.82  14 priced, 116 unpriced
   ✓ Linea                  $24.00  10 priced, 35 unpriced
   ✓ Avalanche               $5.99  15 priced, 30 unpriced

  ──────────────────────────────────────────────────────────────────────────
   …
```


## Setup

```bash
npm install
cp .env.example .env      # then put your Alchemy key in .env
```

`.env` is gitignored — no credential enters version control.

## Usage

```bash
npm start -- 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045
npm start -- 0xd8dA…6045 --networks eth-mainnet,base-mainnet
npm start -- 0xWALLET_A 0xWALLET_B --json > portfolio.json
```

| Option | Default | |
|---|---|---|
| `--networks <list>` | all 10 | Comma-separated networks to query |
| `--max-price-lookups <n>` | `1000` | Cap on extra price calls |
| `--json` | off | Machine-readable output |

**Exit codes carry the trust signal:**

| | |
|---|---|
| `0` | complete — every requested network reported successfully |
| `3` | **INCOMPLETE** — a network failed; the total is a lower bound |
| `2` | bad input or missing config |
| `1` | unexpected error |

A script consuming this must branch on the exit code (or on `complete` in the
JSON). That is the whole point: a partial total should be impossible to
mistake for a real one, by a human *or* a program.

## The failure this is built around

The Portfolio API fans out across chains in one request. When one chain's
backend is unavailable, **the request still returns HTTP 200.** The body
parses. `data.tokens` is populated with every chain that worked. The broken one
is simply absent.

The only trace is a top-level `error.partialErrors` list sitting next to
`data`:

```jsonc
{
  "data": { "tokens": [ /* … 8 chains' worth … */ ] },
  "error": {
    "partialErrors": [
      { "network": "base-mainnet", "message": "Internal error fetching data" }
    ]
  }
}
```

Code that reads `response.data.tokens` and never looks at `response.error`
cannot tell a wallet that holds nothing on Base from a wallet whose Base data
failed to load. Both look like success. So the envelope is inspected **before**
the data is used, on every page.

## Three ways a total goes quietly wrong

**A chain fails.** Handled above — surfaced, named, and the total relabelled.

**A price is missing.** The natural way to write the sum is the wrong one:

```ts
total += balance * (price ?? 0);   // ← understates, silently, with confidence
```

A holding with no available price is *unknown*, not *worthless*. Unpriced
holdings are excluded from the total, counted, and listed in their own section
that says explicitly they are not worth $0.

**A price is matched by symbol.** Symbols are not identifiers — not unique, not
registered, not verified. "USDC" exists at a different address on every chain,
and anyone can deploy a token calling itself USDC. Thousands have. Matching by
symbol values a scam airdrop at $1, which is the most damaging thing a
portfolio tool can get wrong. Every lookup here is keyed on
`network + contract address`, end to end.

## Two kinds of missing price, reported separately

| | Meaning | In the report |
|---|---|---|
| **Network failure** | a whole chain's data is absent | headline warning; total is a lower bound; exit 3 |
| **Per-token error** | the API priced everything else fine, but not this token | listed under *Per-token pricing errors*; total stays trustworthy |

An illiquid token with no market price is a completely normal condition. A
chain being down is not. Collapsing them into one bucket either cries wolf on
every spam airdrop or hides a real outage.

## Design

```
src/
  index.ts       CLI: validate → fetch → price → value → render
  networks.ts    The chains queried, as one explicit constant.
  portfolio.ts   The fan-out request and the envelope inspection.
  prices.ts      Price lookup keyed by (network, contract).
  valuation.ts   The total. Where "missing ≠ zero" is enforced.
  format.ts      The report. Where partial ≠ complete becomes visible.
  http.ts        Shared POST with retry, backoff and pacing.
  config.ts      Credential loading + redaction.
```

`parsePortfolioResponse` and `mergePriceResponse` are **pure functions** over
parsed JSON. That is deliberate: a real chain outage cannot be summoned on
demand, so the partial-failure path has to be testable without one.

**Efficiency.** `withPrices: true` already returns a per-record price for most
holdings, and that price is itself scoped to the contract on its chain. Only
holdings without one need an explicit Prices API call — which keeps a wallet
full of spam airdrops from generating thousands of needless requests. Anything
beyond `--max-price-lookups` is reported as unpriced, never as $0.

**Resilience.** Hundreds of sequential requests will trip a rate limit or
exhaust local sockets. Those retry with exponential backoff (`src/http.ts`);
a batch that ultimately fails marks its holdings unpriced with the reason,
rather than valuing them at zero. A tool built to prevent silent
under-reporting must not commit it itself.

## Tests

```bash
npm test              # 48 tests
npm run typecheck
npm run check:secrets
```

Fixtures are captured from the live API, including the exact per-token error
shape (`{"prices": [], "error": {"message": "Price not found for …"}}`).

One test asserts that two valuations with an **identical total** — one complete,
one partial — render differently. That is check 3 in a single assertion.

To see that difference rather than read about it:

```bash
npm run demo:partial
```

It runs the same holdings through the real parser, valuation and renderer
twice — clean envelope vs `error.partialErrors` — and prints both reports side
by side. Same number, unmistakably different output, exit 0 vs exit 3.

## Scoring

[`SCORING.md`](SCORING.md) maps each scored check to the exact file and line
that satisfies it.
