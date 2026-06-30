/**
 * Reference price source. The quote engine never invents a price — it asks a
 * PriceFeed for the *mid* and applies a deterministic spread on top.
 *
 * In production this is backed by a CEX index / oracle (e.g. the SDK's own
 * PriceProvider, Crypto.com, CoinGecko). Keep it behind this interface so the
 * desk logic stays testable and provider-agnostic.
 */

import { PRICE_SCALE } from './quoteEngine.js';

export interface PriceFeed {
  /**
   * Mid price of `baseSymbol` denominated in `quoteSymbol`, expressed as
   * quote-per-base scaled by PRICE_SCALE. Returns null when no price is known
   * (the desk then refuses to quote rather than guessing).
   */
  midScaled(baseSymbol: string, quoteSymbol: string): Promise<bigint | null>;
}

/** Deterministic feed for tests/sim: fixed prices, no network. */
export class StaticPriceFeed implements PriceFeed {
  /** key 'BASE/QUOTE' -> mid as a human decimal number (quote per 1 base). */
  private readonly table: Map<string, number>;

  constructor(prices: Record<string, number>) {
    this.table = new Map(Object.entries(prices));
  }

  set(pair: string, mid: number): void {
    this.table.set(pair, mid);
  }

  async midScaled(baseSymbol: string, quoteSymbol: string): Promise<bigint | null> {
    const mid = this.table.get(`${baseSymbol}/${quoteSymbol}`);
    if (mid === undefined) return null;
    // Convert human decimal -> scaled bigint without floating-point drift in
    // the integer part; the fractional part is rounded to PRICE_SCALE ticks.
    const whole = BigInt(Math.trunc(mid));
    const frac = BigInt(Math.round((mid - Math.trunc(mid)) * Number(PRICE_SCALE)));
    return whole * PRICE_SCALE + frac;
  }
}

/**
 * Tries each feed in order and returns the first non-null mid. Use to layer a
 * manual override (for illiquid OTC tokens with no CEX market) on top of a live
 * exchange feed: `new CompositePriceFeed([overrides, exchange])`.
 */
export class CompositePriceFeed implements PriceFeed {
  constructor(private readonly feeds: readonly PriceFeed[]) {}

  async midScaled(baseSymbol: string, quoteSymbol: string): Promise<bigint | null> {
    for (const feed of this.feeds) {
      const mid = await feed.midScaled(baseSymbol, quoteSymbol);
      if (mid !== null) return mid;
    }
    return null;
  }
}

/**
 * Aggregates several venues and returns the **median** of the available mids.
 * The median is robust to a single venue printing a bad/stale price (the outlier
 * is medianed out). Refuses (returns null) unless at least `minSources` venues
 * respond, so the desk never prices off a single point of failure.
 */
export class MedianPriceFeed implements PriceFeed {
  constructor(
    private readonly feeds: readonly PriceFeed[],
    private readonly minSources = 2,
  ) {}

  async midScaled(baseSymbol: string, quoteSymbol: string): Promise<bigint | null> {
    const results = await Promise.all(this.feeds.map((f) => f.midScaled(baseSymbol, quoteSymbol)));
    const mids = results.filter((m): m is bigint => m !== null).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (mids.length < this.minSources) return null;
    return median(mids);
  }
}

/** Median of a sorted bigint array (even length → mean of the two middles). */
function median(sorted: readonly bigint[]): bigint {
  const n = sorted.length;
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2n;
}
