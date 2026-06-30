/**
 * Deterministic quote engine.
 *
 * Design rule #1 of the desk: pricing is *code*, never an LLM. Given an RFQ and
 * a reference mid, this returns a firm quote or a typed rejection — same input,
 * same output, every time. No side effects, fully unit-testable.
 */

import type { PriceFeed } from './priceFeed.js';
import type { Inventory } from './inventory.js';
import { timeoutWithinBounds, type PreLockBounds } from './prelock.js';
import type {
  PairSpec,
  ProposalDecision,
  Quote,
  QuoteResult,
  Rfq,
  Side,
  SwapProposal,
} from './types.js';

/** Fixed-point scale for prices: 1e8 ticks per whole-quote-per-whole-base. */
export const PRICE_SCALE = 100_000_000n;
const BPS = 10_000n;

export interface QuoteEngineConfig {
  /** Pairs keyed by base symbol. */
  readonly pairs: Map<string, PairSpec>;
  readonly priceFeed: PriceFeed;
  readonly inventory: Inventory;
  /** Now-provider, injectable for deterministic tests. */
  readonly now: () => number;
  /** Acceptable swap-timeout window for inbound proposals. */
  readonly preLockBounds: PreLockBounds;
}

export class QuoteEngine {
  constructor(private readonly cfg: QuoteEngineConfig) {}

  async price(rfq: Rfq, counterparty: string): Promise<QuoteResult> {
    const pair = this.cfg.pairs.get(rfq.baseSymbol);
    if (!pair) {
      return reject(rfq, 'UNKNOWN_PAIR', rfq.baseSymbol);
    }

    if (rfq.baseAmount <= 0n || rfq.baseAmount > pair.maxDealBase) {
      return reject(rfq, 'SIZE_TOO_LARGE', `max ${pair.maxDealBase}`);
    }

    const mid = await this.cfg.priceFeed.midScaled(pair.base.symbol, pair.quote.symbol);
    if (mid === null) {
      return reject(rfq, 'NO_REFERENCE_PRICE');
    }

    // Apply half-spread: ask when the counterparty buys base (desk sells),
    // bid when the counterparty sells base (desk buys).
    const priceScaled =
      rfq.side === 'buy'
        ? (mid * (BPS + BigInt(pair.spreadBps))) / BPS
        : (mid * (BPS - BigInt(pair.spreadBps))) / BPS;

    const quoteAmount = baseToQuote(rfq.baseAmount, priceScaled, pair);

    // Risk gate. The outgoing leg depends on direction:
    //  - counterparty buys base  -> desk pays out base, receives quote
    //  - counterparty sells base -> desk pays out quote, receives base
    const outCoin = rfq.side === 'buy' ? pair.base.coinId : pair.quote.coinId;
    const outAmount = rfq.side === 'buy' ? rfq.baseAmount : quoteAmount;

    if (!this.cfg.inventory.canCover(outCoin, outAmount)) {
      return reject(rfq, 'INSUFFICIENT_INVENTORY', outCoin);
    }
    // Notional measured in quote units for limit checks.
    const notional = quoteAmount;
    if (!this.cfg.inventory.withinCounterpartyLimit(counterparty, notional)) {
      return reject(rfq, 'COUNTERPARTY_LIMIT');
    }
    if (!this.cfg.inventory.withinExposureLimit(notional)) {
      return reject(rfq, 'EXPOSURE_LIMIT');
    }

    const quote: Quote = {
      rfqId: rfq.rfqId,
      side: rfq.side,
      baseSymbol: pair.base.symbol,
      baseAmount: rfq.baseAmount,
      quoteSymbol: pair.quote.symbol,
      quoteAmount,
      priceScaled,
      expiry: this.cfg.now() + pair.quoteTtlMs,
    };
    return { ok: true, quote };
  }

  /**
   * Decide whether an inbound counter is acceptable. The desk will concede from
   * its quoted price down to its reservation price (set by `floorBps`), but no
   * further. A counter that is *better* for the desk than its own quote is
   * always accepted.
   *
   *   buy  (desk sells base): reservation = mid*(1+floor); accept counter ≥ it
   *   sell (desk buys base):  reservation = mid*(1-floor); accept counter ≤ it
   */
  acceptsCounter(quote: Quote, counterPriceScaled: bigint, pair: PairSpec): boolean {
    const reservation = reservationScaled(quote, pair);
    return quote.side === 'buy'
      ? counterPriceScaled >= reservation
      : counterPriceScaled <= reservation;
  }

  /**
   * Acceptor path: evaluate a swap another agent proposed *to* the desk. Same
   * deterministic price + risk logic as quoting, applied to fixed amounts. The
   * desk accepts only if the implied price is at least as good as its
   * reservation and every risk gate passes.
   */
  async evaluateProposal(p: SwapProposal): Promise<ProposalDecision> {
    const oriented = orient(this.cfg.pairs, p);
    if (!oriented) return { accept: false, reason: 'UNKNOWN_PAIR' };
    const { pair, side, baseAmount, quoteAmount } = oriented;

    if (baseAmount <= 0n || baseAmount > pair.maxDealBase) {
      return { accept: false, reason: 'SIZE_TOO_LARGE' };
    }

    // Pre-lock timeout policy: reject before reserving inventory.
    if (!timeoutWithinBounds(p.timeoutSec, this.cfg.preLockBounds)) {
      return { accept: false, reason: 'TIMEOUT_OUT_OF_RANGE' };
    }

    const mid = await this.cfg.priceFeed.midScaled(pair.base.symbol, pair.quote.symbol);
    if (mid === null) return { accept: false, reason: 'NO_REFERENCE_PRICE' };

    const implied = priceFromAmounts(baseAmount, quoteAmount, pair);
    const floor = BigInt(pair.floorBps);
    // desk sells base (side 'buy'): needs implied ≥ ask reservation = mid*(1+floor)
    // desk buys base  (side 'sell'): needs implied ≤ bid reservation = mid*(1−floor)
    const ok =
      side === 'buy'
        ? implied >= (mid * (BPS + floor)) / BPS
        : implied <= (mid * (BPS - floor)) / BPS;
    if (!ok) return { accept: false, reason: 'PRICE_REJECTED' };

    if (!this.cfg.inventory.canCover(p.deskGivesCoin, p.deskGivesAmount)) {
      return { accept: false, reason: 'INSUFFICIENT_INVENTORY' };
    }
    const notional = quoteAmount;
    if (!this.cfg.inventory.withinCounterpartyLimit(p.counterparty, notional)) {
      return { accept: false, reason: 'COUNTERPARTY_LIMIT' };
    }
    if (!this.cfg.inventory.withinExposureLimit(notional)) {
      return { accept: false, reason: 'EXPOSURE_LIMIT' };
    }

    return {
      accept: true,
      side,
      baseSymbol: pair.base.symbol,
      quoteSymbol: pair.quote.symbol,
      baseAmount,
      quoteAmount,
      impliedPriceScaled: implied,
      notional,
    };
  }
}

/** Find the pair for a proposal and resolve direction + base/quote amounts. */
function orient(
  pairs: Map<string, PairSpec>,
  p: SwapProposal,
): { pair: PairSpec; side: Side; baseAmount: bigint; quoteAmount: bigint } | null {
  for (const pair of pairs.values()) {
    // Desk gives base, gets quote  → counterparty buys base (side 'buy').
    if (p.deskGivesCoin === pair.base.coinId && p.deskGetsCoin === pair.quote.coinId) {
      return { pair, side: 'buy', baseAmount: p.deskGivesAmount, quoteAmount: p.deskGetsAmount };
    }
    // Desk gives quote, gets base  → counterparty sells base (side 'sell').
    if (p.deskGivesCoin === pair.quote.coinId && p.deskGetsCoin === pair.base.coinId) {
      return { pair, side: 'sell', baseAmount: p.deskGetsAmount, quoteAmount: p.deskGivesAmount };
    }
  }
  return null;
}

/** Implied price (quote-per-base, scaled) from the two leg amounts. Inverse of baseToQuote. */
export function priceFromAmounts(baseAmount: bigint, quoteAmount: bigint, pair: PairSpec): bigint {
  if (baseAmount <= 0n) return 0n;
  const num = quoteAmount * PRICE_SCALE * 10n ** BigInt(pair.base.decimals);
  const den = baseAmount * 10n ** BigInt(pair.quote.decimals);
  return num / den;
}

/** Recover the reference mid from a quoted price, then apply the floor spread. */
export function reservationScaled(quote: Quote, pair: PairSpec): bigint {
  const spread = BigInt(pair.spreadBps);
  const floor = BigInt(pair.floorBps);
  // Invert the spread that produced the quote to get back the mid.
  const mid =
    quote.side === 'buy'
      ? (quote.priceScaled * BPS) / (BPS + spread)
      : (quote.priceScaled * BPS) / (BPS - spread);
  return quote.side === 'buy'
    ? (mid * (BPS + floor)) / BPS
    : (mid * (BPS - floor)) / BPS;
}

/**
 * quoteAmount = baseAmount * price, with decimal alignment between coins.
 *   quoteWhole = baseWhole * priceWholePerWhole
 *   => quoteSmallest = baseSmallest * priceScaled * 10^quoteDec
 *                      / (PRICE_SCALE * 10^baseDec)
 */
export function baseToQuote(baseAmount: bigint, priceScaled: bigint, pair: PairSpec): bigint {
  const num = baseAmount * priceScaled * 10n ** BigInt(pair.quote.decimals);
  const den = PRICE_SCALE * 10n ** BigInt(pair.base.decimals);
  return num / den;
}

function reject(rfq: Rfq, reason: import('./types.js').RejectReason, detail?: string): QuoteResult {
  return { ok: false, rejection: detail === undefined ? { rfqId: rfq.rfqId, reason } : { rfqId: rfq.rfqId, reason, detail } };
}
