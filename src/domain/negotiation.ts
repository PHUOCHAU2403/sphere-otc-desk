/**
 * Negotiation state machine (desk / maker side).
 *
 * Sits *above* sphere.swap: it runs the quote↔counter loop over DMs and, once
 * terms are locked, emits SwapTerms for the adapter to hand to sphere.swap. From
 * that point the SDK's own swap state machine (announced → depositing →
 * concluding → completed) drives atomic settlement; this engine only reacts to
 * the resulting swap events to free or commit inventory.
 *
 * Pure: every method returns Effects describing IO to perform — it never sends a
 * DM or touches the chain itself. That keeps it unit-testable with no SDK.
 */

import { QuoteEngine } from './quoteEngine.js';
import type { Inventory } from './inventory.js';
import type { KillSwitch } from './killSwitch.js';
import type { PairSpec, Quote, Rfq, Side, SwapProposal, SwapTerms, WireMsg } from './types.js';

type SessionState = 'quoted' | 'agreed' | 'settled' | 'dead';

interface Session {
  state: SessionState;
  readonly peer: string;
  quote: Quote;
  notional: bigint;
  /** Set once the atomic swap is opened (sphere.swap.proposeSwap → swapId). */
  swapId?: string;
}

/** Serializable form of a session (bigints → strings). */
export interface SessionSnapshot {
  readonly rfqId: string;
  readonly state: SessionState;
  readonly peer: string;
  readonly notional: string;
  readonly swapId?: string;
  readonly quote: {
    rfqId: string;
    side: Side;
    baseSymbol: string;
    baseAmount: string;
    quoteSymbol: string;
    quoteAmount: string;
    priceScaled: string;
    expiry: number;
  };
}

export interface Effects {
  readonly replies: WireMsg[];
  /** Proposer path: open a swap to the counterparty. */
  readonly startSwap?: SwapTerms;
  /** Acceptor path: accept an inbound swap proposal. */
  readonly acceptSwap?: { swapId: string };
  /** Acceptor path: reject an inbound swap proposal. */
  readonly rejectSwap?: { swapId: string; reason: string };
  readonly logs: string[];
}

export interface NegotiationConfig {
  readonly engine: QuoteEngine;
  readonly inventory: Inventory;
  readonly pairs: Map<string, PairSpec>;
  readonly now: () => number;
  /** Swap timeout handed to sphere.swap, in seconds. */
  readonly swapTimeoutSec: number;
  /** Gates new-risk entry points; drives the auto circuit breaker. */
  readonly killSwitch: KillSwitch;
}

export class NegotiationEngine {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly cfg: NegotiationConfig) {}

  /** Handle one inbound wire message from `peer`. */
  async handle(peer: string, msg: WireMsg): Promise<Effects> {
    switch (msg.t) {
      case 'rfq':
        return this.onRfq(peer, msg);
      case 'accept':
        return this.onAccept(peer, msg.rfqId);
      case 'counter':
        return this.onCounter(peer, msg.rfqId, BigInt(msg.priceScaled));
      case 'reject':
        return this.kill(msg.rfqId, `peer rejected: ${msg.reason ?? 'n/a'}`);
      default:
        return effects([], [`ignored message ${(msg as { t: string }).t}`]);
    }
  }

  private async onRfq(peer: string, msg: Extract<WireMsg, { t: 'rfq' }>): Promise<Effects> {
    if (this.cfg.killSwitch.isHalted()) {
      return effects(
        [{ t: 'reject', rfqId: msg.rfqId, reason: 'desk paused' }],
        [`RFQ ${msg.rfqId} refused — desk halted: ${this.cfg.killSwitch.reason()}`],
      );
    }
    const rfq: Rfq = {
      rfqId: msg.rfqId,
      side: msg.side,
      baseSymbol: msg.base,
      baseAmount: BigInt(msg.baseAmount),
    };
    const result = await this.cfg.engine.price(rfq, peer);
    if (!result.ok) {
      return effects(
        [{ t: 'reject', rfqId: rfq.rfqId, reason: result.rejection.reason }],
        [`RFQ ${rfq.rfqId} rejected: ${result.rejection.reason} ${result.rejection.detail ?? ''}`],
      );
    }
    const q = result.quote;
    this.sessions.set(q.rfqId, { state: 'quoted', peer, quote: q, notional: q.quoteAmount });
    return effects([quoteMsg(q)], [`quoted ${q.rfqId}: ${q.baseAmount} ${q.baseSymbol} @ ${q.priceScaled}`]);
  }

  private onCounter(peer: string, rfqId: string, counterPriceScaled: bigint): Effects {
    const s = this.live(rfqId, peer);
    if (!s) return effects([], [`counter for unknown/closed ${rfqId}`]);

    const pair0 = this.cfg.pairs.get(s.quote.baseSymbol)!;
    if (!this.cfg.engine.acceptsCounter(s.quote, counterPriceScaled, pair0)) {
      // Hold our standing quote — the counterparty may try again or take it.
      return effects(
        [quoteMsg(s.quote), { t: 'reject', rfqId, reason: 'counter beyond reservation; standing quote holds' }],
        [`counter rejected ${rfqId}, quote still live`],
      );
    }
    // Accept the counter by re-issuing a firm quote at the countered price.
    const pair = this.cfg.pairs.get(s.quote.baseSymbol)!;
    const requoted = repriceQuote(s.quote, counterPriceScaled, pair, this.cfg.now() + pair.quoteTtlMs);
    s.quote = requoted;
    s.notional = requoted.quoteAmount;
    return effects([quoteMsg(requoted)], [`requoted ${rfqId} at counter ${counterPriceScaled}`]);
  }

  private onAccept(peer: string, rfqId: string): Effects {
    const s = this.live(rfqId, peer);
    if (!s) return effects([], [`accept for unknown/closed ${rfqId}`]);

    if (this.cfg.killSwitch.isHalted()) {
      return effects(
        [{ t: 'reject', rfqId, reason: 'desk paused' }],
        [`accept refused ${rfqId} — desk halted: ${this.cfg.killSwitch.reason()}`],
      );
    }

    if (this.cfg.now() > s.quote.expiry) {
      s.state = 'dead';
      return effects([{ t: 'reject', rfqId, reason: 'quote expired' }], [`accept too late ${rfqId}`]);
    }

    const terms = toSwapTerms(s.quote, peer, this.cfg.pairs, this.cfg.swapTimeoutSec);
    // Reserve the desk's outgoing leg so concurrent deals can't double-spend it.
    this.cfg.inventory.reserve(rfqId, terms.deskGivesCoin, terms.deskGivesAmount, peer, s.notional);
    s.state = 'agreed';
    return { replies: [], startSwap: terms, logs: [`agreed ${rfqId} -> starting swap`] };
  }

  /**
   * Acceptor path: another agent proposed a swap directly to the desk. Evaluate
   * it deterministically; on accept, reserve inventory and synthesize an agreed
   * session keyed by swapId so settlement/persistence reuse the proposer path.
   */
  async onProposalReceived(p: SwapProposal): Promise<Effects> {
    if (this.sessions.has(p.swapId)) {
      return effects([], [`duplicate proposal ${p.swapId} ignored`]);
    }
    if (this.cfg.killSwitch.isHalted()) {
      return {
        replies: [],
        rejectSwap: { swapId: p.swapId, reason: 'desk paused' },
        logs: [`proposal ${p.swapId} refused — desk halted: ${this.cfg.killSwitch.reason()}`],
      };
    }
    const d = await this.cfg.engine.evaluateProposal(p);
    if (!d.accept) {
      return {
        replies: [],
        rejectSwap: { swapId: p.swapId, reason: d.reason },
        logs: [`proposal ${p.swapId} rejected: ${d.reason}`],
      };
    }

    const pair = this.cfg.pairs.get(d.baseSymbol)!;
    const quote: Quote = {
      rfqId: p.swapId, // sessions for accepted proposals are keyed by swapId
      side: d.side,
      baseSymbol: d.baseSymbol,
      baseAmount: d.baseAmount,
      quoteSymbol: d.quoteSymbol,
      quoteAmount: d.quoteAmount,
      priceScaled: d.impliedPriceScaled,
      expiry: this.cfg.now() + pair.quoteTtlMs,
    };
    this.sessions.set(p.swapId, {
      state: 'agreed',
      peer: p.counterparty,
      quote,
      notional: d.notional,
      swapId: p.swapId,
    });
    this.cfg.inventory.reserve(p.swapId, p.deskGivesCoin, p.deskGivesAmount, p.counterparty, d.notional);
    return {
      replies: [],
      acceptSwap: { swapId: p.swapId },
      logs: [`proposal ${p.swapId} accepted: ${d.baseAmount} ${d.baseSymbol} @ ${d.impliedPriceScaled}`],
    };
  }

  // --- swap-event reactions (called by the adapter) ---

  onSwapCompleted(rfqId: string): Effects {
    const s = this.sessions.get(rfqId);
    if (!s) return effects([], [`swap completed for untracked ${rfqId}`]);
    const terms = toSwapTerms(s.quote, s.peer, this.cfg.pairs, this.cfg.swapTimeoutSec);
    this.cfg.inventory.settle(rfqId, terms.deskGetsCoin, terms.deskGetsAmount);
    s.state = 'settled';
    this.cfg.killSwitch.recordSuccess();
    return effects([], [`settled ${rfqId}: received ${terms.deskGetsAmount} ${terms.deskGetsCoin}`]);
  }

  onSwapFailed(rfqId: string, reason: string): Effects {
    const s = this.sessions.get(rfqId);
    if (!s) return effects([], [`swap failed for untracked ${rfqId}`]);
    this.cfg.inventory.release(rfqId);
    s.state = 'dead';
    const tripped = this.cfg.killSwitch.recordFailure();
    const logs = [`swap failed ${rfqId} (${reason}) — inventory released`];
    if (tripped) logs.push(`*** CIRCUIT BREAKER TRIPPED — ${this.cfg.killSwitch.reason()} ***`);
    return effects([], logs);
  }

  // --- swapId mapping (persisted with the session, used by the adapter) ---

  /** Record the swapId returned by proposeSwap so swap events can route back. */
  attachSwap(rfqId: string, swapId: string): void {
    const s = this.sessions.get(rfqId);
    if (s) s.swapId = swapId;
  }

  rfqIdForSwap(swapId: string): string | undefined {
    for (const [rfqId, s] of this.sessions) if (s.swapId === swapId) return rfqId;
    return undefined;
  }

  /** Agreed-but-unsettled deals — the set that must be reconciled after a restart. */
  agreedSessions(): Array<{ rfqId: string; swapId?: string }> {
    const out: Array<{ rfqId: string; swapId?: string }> = [];
    for (const [rfqId, s] of this.sessions) {
      if (s.state === 'agreed') out.push(s.swapId === undefined ? { rfqId } : { rfqId, swapId: s.swapId });
    }
    return out;
  }

  getSession(rfqId: string): Readonly<Session> | undefined {
    return this.sessions.get(rfqId);
  }

  /** SwapTerms for a session (what the desk gives/gets) — used by the pre-lock check. */
  termsFor(rfqId: string): SwapTerms | undefined {
    const s = this.sessions.get(rfqId);
    if (!s) return undefined;
    return toSwapTerms(s.quote, s.peer, this.cfg.pairs, this.cfg.swapTimeoutSec);
  }

  private kill(rfqId: string, why: string): Effects {
    const s = this.sessions.get(rfqId);
    if (s && s.state === 'agreed') this.cfg.inventory.release(rfqId);
    if (s) s.state = 'dead';
    return effects([], [why]);
  }

  // --- persistence ---

  /** Snapshot non-terminal sessions; terminal ones aren't worth restoring. */
  toSnapshot(): SessionSnapshot[] {
    const out: SessionSnapshot[] = [];
    for (const [rfqId, s] of this.sessions) {
      if (s.state === 'settled' || s.state === 'dead') continue;
      const q = s.quote;
      out.push({
        rfqId,
        state: s.state,
        peer: s.peer,
        notional: s.notional.toString(),
        ...(s.swapId === undefined ? {} : { swapId: s.swapId }),
        quote: {
          rfqId: q.rfqId,
          side: q.side,
          baseSymbol: q.baseSymbol,
          baseAmount: q.baseAmount.toString(),
          quoteSymbol: q.quoteSymbol,
          quoteAmount: q.quoteAmount.toString(),
          priceScaled: q.priceScaled.toString(),
          expiry: q.expiry,
        },
      });
    }
    return out;
  }

  /** Rehydrate sessions from a snapshot (call right after construction). */
  restore(snaps: readonly SessionSnapshot[]): void {
    for (const snap of snaps) {
      const quote: Quote = {
        rfqId: snap.quote.rfqId,
        side: snap.quote.side,
        baseSymbol: snap.quote.baseSymbol,
        baseAmount: BigInt(snap.quote.baseAmount),
        quoteSymbol: snap.quote.quoteSymbol,
        quoteAmount: BigInt(snap.quote.quoteAmount),
        priceScaled: BigInt(snap.quote.priceScaled),
        expiry: snap.quote.expiry,
      };
      const session: Session = { state: snap.state, peer: snap.peer, quote, notional: BigInt(snap.notional) };
      if (snap.swapId !== undefined) session.swapId = snap.swapId;
      this.sessions.set(snap.rfqId, session);
    }
  }

  private live(rfqId: string, peer: string): Session | undefined {
    const s = this.sessions.get(rfqId);
    if (!s || s.peer !== peer) return undefined;
    if (s.state !== 'quoted') return undefined;
    return s;
  }
}

// --- helpers ---

function effects(replies: WireMsg[], logs: string[]): Effects {
  return { replies, logs };
}

function quoteMsg(q: Quote): Extract<WireMsg, { t: 'quote' }> {
  return {
    t: 'quote',
    rfqId: q.rfqId,
    side: q.side,
    base: q.baseSymbol,
    baseAmount: q.baseAmount.toString(),
    quote: q.quoteSymbol,
    quoteAmount: q.quoteAmount.toString(),
    priceScaled: q.priceScaled.toString(),
    expiry: q.expiry,
  };
}

function repriceQuote(prev: Quote, priceScaled: bigint, pair: PairSpec, expiry: number): Quote {
  // Recompute the quote leg at the new price; base leg unchanged.
  const quoteAmount =
    (prev.baseAmount * priceScaled * 10n ** BigInt(pair.quote.decimals)) /
    (100_000_000n * 10n ** BigInt(pair.base.decimals));
  return { ...prev, priceScaled, quoteAmount, expiry };
}

function toSwapTerms(
  q: Quote,
  peer: string,
  pairs: Map<string, PairSpec>,
  timeoutSec: number,
): SwapTerms {
  const pair = pairs.get(q.baseSymbol)!;
  const buy = q.side === 'buy'; // counterparty buys base => desk gives base
  return {
    rfqId: q.rfqId,
    deskGivesCoin: buy ? pair.base.coinId : pair.quote.coinId,
    deskGivesAmount: buy ? q.baseAmount : q.quoteAmount,
    deskGetsCoin: buy ? pair.quote.coinId : pair.base.coinId,
    deskGetsAmount: buy ? q.quoteAmount : q.baseAmount,
    counterparty: peer,
    timeoutSec,
  };
}
