/**
 * Daily P&L tracker + loss breaker input.
 *
 * P&L for a market-maker desk is best measured as mark-to-market *equity*: value
 * all inventory in a single numéraire (USDU) at the current mid, and compare to
 * the equity at the start of the UTC day. This one number captures both the
 * spread the desk earned and any mark-to-market loss from holding inventory while
 * the mid moved against it. The breaker trips when the daily drawdown exceeds a
 * limit.
 *
 * Pure: equity marking and the day comparison are deterministic; the adapter
 * supplies live mids and persists the baseline.
 */

import { PRICE_SCALE } from './quoteEngine.js';

export interface Holding {
  readonly coin: string;
  readonly amount: bigint; // smallest units
  readonly decimals: number;
}

export interface NumeraireSpec {
  readonly coin: string;
  readonly decimals: number;
}

/**
 * Total equity in numéraire smallest units. `midsScaled` maps each non-numéraire
 * coin → mid (numéraire-per-coin, scaled by PRICE_SCALE). Returns null if any
 * coin with a non-zero balance can't be marked — the caller should then skip the
 * decision rather than act on a partial mark.
 */
export function markToNumeraire(
  holdings: readonly Holding[],
  midsScaled: ReadonlyMap<string, bigint>,
  numeraire: NumeraireSpec,
): bigint | null {
  let total = 0n;
  for (const h of holdings) {
    if (h.amount === 0n) continue;
    if (h.coin === numeraire.coin) {
      total += h.amount;
      continue;
    }
    const mid = midsScaled.get(h.coin);
    if (mid === undefined) return null; // can't mark this coin → bail
    // value = amount * mid * 10^numDec / (PRICE_SCALE * 10^coinDec)
    const num = h.amount * mid * 10n ** BigInt(numeraire.decimals);
    const den = PRICE_SCALE * 10n ** BigInt(h.decimals);
    total += num / den;
  }
  return total;
}

export interface PnlMark {
  readonly dailyPnl: bigint; // numéraire smallest units (negative = loss)
  readonly breach: boolean;
  readonly rebaselined: boolean;
}

export interface PnlSnapshot {
  readonly baseline: string | null;
  readonly baselineDay: string;
}

export class PnlTracker {
  private baseline: bigint | null = null;
  private baselineDay = '';

  /** @param maxDailyLoss positive numéraire smallest units; trip if loss ≥ this. */
  constructor(private readonly maxDailyLoss: bigint) {}

  /**
   * Record current equity for `utcDay` (YYYY-MM-DD). The first mark of a new day
   * sets the baseline (dailyPnl 0); subsequent marks compute the drawdown and
   * flag a breach when the loss meets the limit.
   */
  mark(equity: bigint, utcDay: string): PnlMark {
    if (this.baseline === null || this.baselineDay !== utcDay) {
      this.baseline = equity;
      this.baselineDay = utcDay;
      return { dailyPnl: 0n, breach: false, rebaselined: true };
    }
    const dailyPnl = equity - this.baseline;
    return { dailyPnl, breach: dailyPnl <= -this.maxDailyLoss, rebaselined: false };
  }

  baselineEquity(): bigint | null {
    return this.baseline;
  }

  toSnapshot(): PnlSnapshot {
    return { baseline: this.baseline === null ? null : this.baseline.toString(), baselineDay: this.baselineDay };
  }

  static restore(maxDailyLoss: bigint, snap: PnlSnapshot): PnlTracker {
    const t = new PnlTracker(maxDailyLoss);
    t.baseline = snap.baseline === null ? null : BigInt(snap.baseline);
    t.baselineDay = snap.baselineDay;
    return t;
  }
}
