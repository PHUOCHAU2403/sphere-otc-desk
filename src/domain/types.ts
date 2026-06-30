/**
 * Domain types for the OTC desk — intentionally free of any Sphere SDK import.
 * Amounts are bigint in *smallest units* everywhere in the domain; conversion to
 * the SDK's string form happens only at the adapter boundary (src/adapters).
 */

/** A tradable coin known to the desk. */
export interface CoinSpec {
  /** Sphere coinId (hex) or symbol the SDK understands, e.g. 'UCT' / '0x...'. */
  readonly coinId: string;
  readonly symbol: string;
  /** Decimal places: 1 whole unit == 10^decimals smallest units. */
  readonly decimals: number;
}

/** A pair the desk is willing to make a market in: base priced in quote. */
export interface PairSpec {
  readonly base: CoinSpec;
  readonly quote: CoinSpec;
  /** Half-spread applied to the reference mid, in basis points (100 bps = 1%). */
  readonly spreadBps: number;
  /**
   * Minimum half-spread the desk will concede to during negotiation. The desk
   * quotes at `spreadBps` but will accept a counter down to `floorBps`
   * (its reservation price). Must be ≤ spreadBps. 0 = will trade at mid.
   */
  readonly floorBps: number;
  /** Largest single deal the desk will quote, in base smallest units. */
  readonly maxDealBase: bigint;
  /** Quote validity window in milliseconds. */
  readonly quoteTtlMs: number;
}

/** Counterparty's perspective: do they buy or sell the *base* coin? */
export type Side = 'buy' | 'sell';

/** A structured request for quote, parsed from an inbound DM. */
export interface Rfq {
  readonly rfqId: string;
  readonly side: Side;
  readonly baseSymbol: string;
  /** Desired base quantity in smallest units. */
  readonly baseAmount: bigint;
}

/** A firm price the desk is willing to honour until `expiry`. */
export interface Quote {
  readonly rfqId: string;
  readonly side: Side;
  readonly baseSymbol: string;
  readonly baseAmount: bigint;
  readonly quoteSymbol: string;
  readonly quoteAmount: bigint;
  /** quote-per-base, scaled by PRICE_SCALE (see quoteEngine). */
  readonly priceScaled: bigint;
  /** Unix ms when this quote stops being honoured. */
  readonly expiry: number;
}

/** Why the desk declined to quote. */
export interface QuoteRejection {
  readonly rfqId: string;
  readonly reason: RejectReason;
  readonly detail?: string;
}

export type RejectReason =
  | 'UNKNOWN_PAIR'
  | 'SIZE_TOO_LARGE'
  | 'INSUFFICIENT_INVENTORY'
  | 'COUNTERPARTY_LIMIT'
  | 'EXPOSURE_LIMIT'
  | 'NO_REFERENCE_PRICE';

export type QuoteResult =
  | { ok: true; quote: Quote }
  | { ok: false; rejection: QuoteRejection };

/**
 * Wire protocol — JSON serialized into encrypted DMs. Agent-to-agent traffic is
 * structured; a human counterparty would be handled by an LLM adapter that
 * emits/parses these same shapes.
 */
export type WireMsg =
  | { t: 'rfq'; rfqId: string; side: Side; base: string; baseAmount: string }
  | {
      t: 'quote';
      rfqId: string;
      side: Side;
      base: string;
      baseAmount: string;
      quote: string;
      quoteAmount: string;
      priceScaled: string;
      expiry: number;
    }
  | { t: 'accept'; rfqId: string }
  | { t: 'counter'; rfqId: string; priceScaled: string }
  | { t: 'reject'; rfqId: string; reason?: string };

/**
 * An inbound swap proposed *to* the desk by another agent (acceptor path),
 * already mapped to the desk's perspective from the SDK's SwapDeal.
 */
export interface SwapProposal {
  readonly swapId: string;
  readonly counterparty: string;
  /** What the desk would deposit (partyB leg). */
  readonly deskGivesCoin: string;
  readonly deskGivesAmount: bigint;
  /** What the desk would receive (partyA leg). */
  readonly deskGetsCoin: string;
  readonly deskGetsAmount: bigint;
  /** Swap timeout the counterparty proposed, in seconds. */
  readonly timeoutSec: number;
}

export type ProposalRejectReason =
  | 'UNKNOWN_PAIR'
  | 'SIZE_TOO_LARGE'
  | 'TIMEOUT_OUT_OF_RANGE'
  | 'NO_REFERENCE_PRICE'
  | 'PRICE_REJECTED'
  | 'INSUFFICIENT_INVENTORY'
  | 'COUNTERPARTY_LIMIT'
  | 'EXPOSURE_LIMIT';

export type ProposalDecision =
  | {
      readonly accept: true;
      readonly side: Side;
      readonly baseSymbol: string;
      readonly quoteSymbol: string;
      readonly baseAmount: bigint;
      readonly quoteAmount: bigint;
      readonly impliedPriceScaled: bigint;
      readonly notional: bigint;
    }
  | { readonly accept: false; readonly reason: ProposalRejectReason };

/** Terms locked in once both sides agree — handed to the swap adapter. */
export interface SwapTerms {
  readonly rfqId: string;
  /** What the desk pays out. */
  readonly deskGivesCoin: string;
  readonly deskGivesAmount: bigint;
  /** What the desk receives. */
  readonly deskGetsCoin: string;
  readonly deskGetsAmount: bigint;
  readonly counterparty: string;
  /** Swap timeout in seconds, passed through to sphere.swap. */
  readonly timeoutSec: number;
}
