import type { Holding, Valuation } from './types.js';

/**
 * Rendering the valuation.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  AN INCOMPLETE TOTAL MUST NOT LOOK LIKE A COMPLETE ONE
 * ─────────────────────────────────────────────────────────────────────────
 * The failure mode this whole tool exists to prevent is a number that is
 * quietly too low. If a chain's data did not arrive, the output changes
 * *visibly*: a warning banner, the total relabelled from "TOTAL" to
 * "AT LEAST … INCOMPLETE", the failed chains named, and a non-zero exit code.
 *
 * A complete run and a partial run are never confusable at a glance.
 */

const useColor =
  process.stdout.isTTY === true && !process.env['NO_COLOR'] && process.env['TERM'] !== 'dumb';

const ansi =
  (code: string) =>
  (s: string): string =>
    useColor ? `\x1b[${code}m${s}\x1b[0m` : s;

const color = {
  dim: ansi('2'),
  bold: ansi('1'),
  red: ansi('31'),
  green: ansi('32'),
  yellow: ansi('33'),
  cyan: ansi('36'),
};

const WIDTH = 74;
const RULE = '─'.repeat(WIDTH);
const HEAVY = '═'.repeat(WIDTH);

export function renderValuation(valuation: Valuation): string {
  const lines: string[] = [];

  lines.push(color.dim(HEAVY));
  lines.push(`  ${color.bold('Multi-Chain Portfolio')}`);
  for (const address of valuation.addresses) {
    lines.push(`  ${address}`);
  }
  lines.push(color.dim(HEAVY));
  lines.push('');

  // ── The headline number, labelled according to whether it can be trusted ──
  if (valuation.complete) {
    lines.push(`  ${color.dim('TOTAL')}   ${color.bold(color.green(usd(valuation.totalUsd)))}`);
    lines.push(
      color.dim(
        `           across ${valuation.networksRequested.length} networks · all chains reported successfully`,
      ),
    );
  } else {
    lines.push(
      `  ${color.red(color.bold('⚠  INCOMPLETE — THIS TOTAL IS A LOWER BOUND'))}`,
    );
    lines.push('');
    lines.push(
      `  ${color.dim('AT LEAST')}   ${color.bold(color.yellow(usd(valuation.totalUsd)))}`,
    );
    lines.push(
      color.red(
        `              ${valuation.failedNetworks.length} of ${valuation.networksRequested.length} networks failed to report — their holdings are NOT in this number`,
      ),
    );
    lines.push('');
    for (const failure of valuation.failedNetworks) {
      lines.push(color.red(`     ✗ ${pad(failure.network, 18)} ${failure.message}`));
    }
  }

  lines.push('');
  lines.push(color.dim(`  ${RULE}`));
  lines.push('');
  lines.push(`  ${color.bold('By network')}`);
  lines.push('');

  for (const row of valuation.breakdown) {
    if (row.failed) {
      lines.push(
        `   ${color.red('✗')} ${pad(row.label, 14)} ${padStart(color.red('FAILED'), 14)}  ` +
          color.red('data unavailable — not counted'),
      );
      continue;
    }

    if (row.holdingCount === 0) {
      lines.push(
        `   ${color.dim('·')} ${color.dim(pad(row.label, 14))} ${padStart(color.dim('—'), 14)}  ${color.dim('no holdings')}`,
      );
      continue;
    }

    const note =
      row.unpricedCount > 0
        ? color.yellow(`${row.pricedCount} priced, ${row.unpricedCount} unpriced`)
        : color.dim(`${row.pricedCount} token${row.pricedCount === 1 ? '' : 's'}`);

    lines.push(`   ${color.green('✓')} ${pad(row.label, 14)} ${padStart(usd(row.valueUsd), 14)}  ${note}`);
  }

  lines.push('');
  lines.push(color.dim(`  ${RULE}`));
  lines.push('');
  lines.push(`  ${color.bold('Holdings')}`);
  lines.push('');

  const priced = valuation.holdings
    .filter((h) => h.valueUsd !== null)
    .sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));

  if (priced.length === 0) {
    lines.push(color.dim('   (nothing priced)'));
  }

  for (const holding of priced.slice(0, 40)) {
    lines.push(renderHolding(holding));
  }
  if (priced.length > 40) {
    lines.push(color.dim(`   … and ${priced.length - 40} more priced holdings`));
  }

  // ── Excluded holdings, always visible, never folded into the total ──
  const excluded = [...valuation.unpriced, ...valuation.tokenErrors];
  if (excluded.length > 0) {
    lines.push('');
    lines.push(color.dim(`  ${RULE}`));
    lines.push('');
    lines.push(
      `  ${color.bold(color.yellow(`Excluded from the total — ${excluded.length} holding${excluded.length === 1 ? '' : 's'} with no usable price`))}`,
    );
    lines.push(
      color.dim(
        '  These contribute nothing to the number above. They are NOT worth $0 —',
      ),
    );
    lines.push(color.dim('  their value is unknown, so counting them as zero would understate the total.'));
    lines.push('');

    // Per-token pricing errors are reported separately from network outages.
    if (valuation.tokenErrors.length > 0) {
      lines.push(color.dim(`   Per-token pricing errors (${valuation.tokenErrors.length}):`));
      for (const holding of valuation.tokenErrors.slice(0, 8)) {
        lines.push(
          `     ${color.yellow('!')} ${pad(holding.symbol, 12)} ${pad(holding.network, 15)} ${color.dim(reasonOf(holding))}`,
        );
      }
      if (valuation.tokenErrors.length > 8) {
        lines.push(color.dim(`     … and ${valuation.tokenErrors.length - 8} more`));
      }
      lines.push('');
    }

    if (valuation.unpriced.length > 0) {
      lines.push(color.dim(`   No price available (${valuation.unpriced.length}):`));
      for (const holding of valuation.unpriced.slice(0, 8)) {
        lines.push(
          `     ${color.dim('?')} ${pad(holding.symbol, 12)} ${pad(holding.network, 15)} ${color.dim(reasonOf(holding))}`,
        );
      }
      if (valuation.unpriced.length > 8) {
        lines.push(color.dim(`     … and ${valuation.unpriced.length - 8} more`));
      }
    }
  }

  lines.push('');
  lines.push(color.dim(`  ${RULE}`));
  lines.push(
    color.dim(
      `  ${valuation.holdings.length} holdings · ${valuation.pagesFetched} page${valuation.pagesFetched === 1 ? '' : 's'} fetched · ` +
        `${valuation.networksRequested.length} networks requested in one fan-out call`,
    ),
  );

  // Repeat the warning at the bottom: a long report scrolls the header away.
  if (!valuation.complete) {
    lines.push('');
    lines.push(
      color.red(
        color.bold(
          `  ⚠  Reminder: ${valuation.failedNetworks.length} network(s) failed. The total above is incomplete.`,
        ),
      ),
    );
  }

  lines.push('');
  return lines.join('\n');
}

function renderHolding(holding: Holding): string {
  const balance = holding.balance === null ? '?' : formatAmount(holding.balance);
  const native = holding.isNative ? color.cyan(' ⬦') : '  ';

  return (
    `   ${pad(holding.symbol, 12)}${native} ${padStart(balance, 18)} ` +
    `${padStart(usd(holding.valueUsd ?? 0), 14)}  ${color.dim(holding.network)}`
  );
}

function reasonOf(holding: Holding): string {
  if (holding.price.kind === 'no-price') return holding.price.reason;
  if (holding.price.kind === 'token-error') return holding.price.reason;
  return '';
}

/** JSON output. `complete` is the field a consumer must branch on. */
export function renderJson(valuation: Valuation): string {
  return JSON.stringify(
    {
      addresses: valuation.addresses,
      totalUsd: valuation.totalUsd,
      // False means totalUsd is a lower bound, not the answer.
      complete: valuation.complete,
      totalLabel: valuation.complete ? 'total' : 'at-least (incomplete)',
      failedNetworks: valuation.failedNetworks,
      networksRequested: valuation.networksRequested,
      breakdown: valuation.breakdown,
      excludedFromTotal: {
        unpricedCount: valuation.unpriced.length,
        tokenErrorCount: valuation.tokenErrors.length,
      },
      holdings: valuation.holdings.map((h) => ({
        ...h,
        rawBalance: h.rawBalance.toString(),
      })),
      pagesFetched: valuation.pagesFetched,
    },
    null,
    2,
  );
}

function usd(value: number): string {
  if (!Number.isFinite(value)) return '$?';
  if (value !== 0 && Math.abs(value) < 0.01) return '<$0.01';
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Format a token balance for the amount column.
 *
 * Memecoin and spam-airdrop supplies run to the trillions, and printing
 * `1,777,819,000,000.1777` in full both overflows the column and tells the
 * reader nothing. Large balances collapse to compact notation; small ones keep
 * their precision, which is where it actually matters.
 */
function formatAmount(value: number): string {
  const abs = Math.abs(value);

  if (abs !== 0 && abs < 0.0001) return value.toExponential(2);

  for (const [threshold, suffix] of [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
  ] as const) {
    if (abs >= threshold) {
      return `${(value / threshold).toLocaleString('en-US', { maximumFractionDigits: 2 })}${suffix}`;
    }
  }

  return value.toLocaleString('en-US', { maximumFractionDigits: abs >= 1 ? 4 : 8 });
}

/** Pad ignoring ANSI escapes, so colour never breaks column alignment. */
function visibleLength(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function pad(text: string, width: number): string {
  const len = visibleLength(text);
  return len >= width ? text : text + ' '.repeat(width - len);
}

function padStart(text: string, width: number): string {
  const len = visibleLength(text);
  return len >= width ? text : ' '.repeat(width - len) + text;
}
