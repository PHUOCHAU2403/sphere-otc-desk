/**
 * Adapter: binds the pure domain core to the live Sphere SDK.
 *
 * Responsibilities (all the IO the domain refuses to do):
 *   - parse inbound DMs into WireMsg and feed the NegotiationEngine
 *   - send the engine's reply messages back over encrypted DM
 *   - when terms lock, open the atomic swap via sphere.swap.proposeSwap
 *   - drive the proposer deposit and react to swap:* events to commit/release
 *     inventory through the engine
 *   - persist after every state change, and reconcile in-flight swaps on boot
 *
 * The SDK's own swap state machine owns settlement atomicity (escrow-based).
 * This file only orchestrates the handoff and durability.
 */

import type { Sphere } from '@unicitylabs/sphere-sdk';
import type { NegotiationEngine, Effects } from '../domain/negotiation.js';
import type { Inventory } from '../domain/inventory.js';
import type { KillSwitch } from '../domain/killSwitch.js';
import type { PriceFeed } from '../domain/priceFeed.js';
import { markToNumeraire, type PnlTracker, type Holding } from '../domain/pnl.js';
import { gateOnVerification } from '../domain/prelock.js';
import type { AuditLog } from '../domain/audit.js';
import type { CounterpartyVerifier } from './counterpartyVerifier.js';
import type { Persister } from './persister.js';
import type { PairSpec, WireMsg, SwapTerms, SwapProposal } from '../domain/types.js';

/** The SDK's SwapDeal as delivered in a swap:proposal_received event. */
interface IncomingDeal {
  readonly partyA: string;
  readonly partyB: string;
  readonly partyACurrency: string;
  readonly partyAAmount: string;
  readonly partyBCurrency: string;
  readonly partyBAmount: string;
  readonly timeout: number;
}

export interface SphereDeskOptions {
  readonly sphere: Sphere;
  readonly negotiation: NegotiationEngine;
  readonly inventory: Inventory;
  readonly persister: Persister;
  readonly killSwitch: KillSwitch;
  readonly pnl: PnlTracker;
  readonly pairs: Map<string, PairSpec>;
  readonly priceFeed: PriceFeed;
  readonly audit: AuditLog;
  readonly escrowAddress: string;
  /** Map exchange/asset symbol → the coinId used in the ledger. */
  readonly symbolToCoin: Readonly<Record<string, string>>;
  /** On-chain pre-lock counterparty verification. */
  readonly verifier: CounterpartyVerifier;
  /** If true, a failed counterparty verification blocks the lock. */
  readonly requireVerification: boolean;
  readonly log?: (line: string) => void;
}

export class SphereOtcDesk {
  private readonly sphere: Sphere;
  private readonly neg: NegotiationEngine;
  private readonly inventory: Inventory;
  private readonly persister: Persister;
  private readonly killSwitch: KillSwitch;
  private readonly pnl: PnlTracker;
  private readonly pairs: Map<string, PairSpec>;
  private readonly priceFeed: PriceFeed;
  private readonly audit: AuditLog;
  private readonly escrow: string;
  private readonly symbolToCoin: Readonly<Record<string, string>>;
  private readonly verifier: CounterpartyVerifier;
  private readonly requireVerification: boolean;
  private readonly log: (line: string) => void;
  private lastHalted = false;
  private lastPnlRecorded: bigint | null = null;

  constructor(opts: SphereDeskOptions) {
    this.sphere = opts.sphere;
    this.neg = opts.negotiation;
    this.inventory = opts.inventory;
    this.persister = opts.persister;
    this.killSwitch = opts.killSwitch;
    this.pnl = opts.pnl;
    this.pairs = opts.pairs;
    this.priceFeed = opts.priceFeed;
    this.audit = opts.audit;
    this.escrow = opts.escrowAddress;
    this.symbolToCoin = opts.symbolToCoin;
    this.verifier = opts.verifier;
    this.requireVerification = opts.requireVerification;
    this.log = opts.log ?? ((l) => console.log(l));
  }

  /**
   * Pre-lock counterparty check: verify the counterparty can deliver their leg
   * before we lock our own token. Returns true if it's safe to proceed.
   */
  private async preLockOk(swapId: string, party: string, coin: string, amount: bigint): Promise<boolean> {
    const v = await this.verifier.verify(party, coin, amount);
    const gate = gateOnVerification(v, this.requireVerification);
    this.record('prelock_check', { swapId, party, ok: gate.ok, detail: v.reason });
    return gate.ok;
  }

  /** Fire-and-forget audit; logs but never throws into the hot path. */
  private record(type: string, data: Record<string, unknown>): void {
    void this.audit.append(type, data).catch((err) => this.log(`audit error: ${String(err)}`));
  }

  /** Emit a kill-switch audit event when the halt state changes. */
  private auditKillTransition(): void {
    const halted = this.killSwitch.isHalted();
    if (halted === this.lastHalted) return;
    this.lastHalted = halted;
    this.record(halted ? 'kill_halted' : 'kill_resumed', { reason: this.killSwitch.reason() });
  }

  /** Subscribe to DMs and swap events. Returns an unsubscribe function. */
  start(): () => void {
    const offDm = this.sphere.communications.onDirectMessage((m) => {
      void this.onDm(m.senderNametag ?? m.senderPubkey, m.content);
    });

    // Credit incoming token transfers in real-time (deposits to the desk wallet).
    const offIncoming = this.sphere.on('transfer:incoming', () => {
      this.log('incoming transfer detected — receiving…');
      void this.pullAndReconcile().catch((e) => this.log(`receive error: ${String(e)}`));
    });

    const offProposal = this.sphere.on('swap:proposal_received', (e) => {
      const d = e.deal as Record<string, unknown>;
      const deal: IncomingDeal = {
        partyA: String(d['partyA'] ?? ''),
        partyB: String(d['partyB'] ?? ''),
        partyACurrency: String(d['partyACurrency'] ?? ''),
        partyAAmount: String(d['partyAAmount'] ?? '0'),
        partyBCurrency: String(d['partyBCurrency'] ?? ''),
        partyBAmount: String(d['partyBAmount'] ?? '0'),
        timeout: Number(d['timeout'] ?? 0),
      };
      const ev = e.senderNametag === undefined
        ? { swapId: e.swapId, deal, senderPubkey: e.senderPubkey }
        : { swapId: e.swapId, deal, senderPubkey: e.senderPubkey, senderNametag: e.senderNametag };
      void this.onProposal(ev);
    });

    const offAnnounced = this.sphere.on('swap:announced', (e: { swapId: string }) => {
      void this.onAnnounced(e.swapId);
    });

    const offCompleted = this.sphere.on(
      'swap:completed',
      (e: { swapId: string; payoutVerified: boolean }) => {
        const rfqId = this.neg.rfqIdForSwap(e.swapId);
        if (!rfqId) return;
        if (!e.payoutVerified) this.log(`WARN: swap ${e.swapId} completed but payout NOT verified`);
        this.record('swap_completed', { swapId: e.swapId, rfqId, payoutVerified: e.payoutVerified });
        this.react(this.neg.onSwapCompleted(rfqId));
      },
    );

    const offFailed = this.sphere.on('swap:failed', (e: { swapId: string; error: string }) => {
      const rfqId = this.neg.rfqIdForSwap(e.swapId);
      if (!rfqId) return;
      this.record('swap_failed', { swapId: e.swapId, rfqId, error: e.error });
      this.react(this.neg.onSwapFailed(rfqId, e.error));
    });

    const offCancelled = this.sphere.on('swap:cancelled', (e: { swapId: string; reason: string }) => {
      const rfqId = this.neg.rfqIdForSwap(e.swapId);
      if (!rfqId) return;
      this.record('swap_cancelled', { swapId: e.swapId, rfqId, reason: e.reason });
      this.react(this.neg.onSwapFailed(rfqId, `cancelled: ${e.reason}`));
    });

    return () => {
      offDm();
      offIncoming();
      offProposal();
      offAnnounced();
      offCompleted();
      offFailed();
      offCancelled();
    };
  }

  /**
   * Acceptor path: an agent proposed a swap directly to the desk. Map the SDK
   * deal into the desk's perspective (proposer = partyA = sender; desk = partyB),
   * let the engine decide, and accept or reject on-chain.
   */
  private async onProposal(e: {
    swapId: string;
    deal: IncomingDeal;
    senderPubkey: string;
    senderNametag?: string;
  }): Promise<void> {
    const me = this.sphere.identity?.directAddress;
    if (me && e.deal.partyB !== me) {
      this.log(`proposal ${e.swapId} not addressed to this desk — ignoring`);
      return;
    }
    const proposal: SwapProposal = {
      swapId: e.swapId,
      counterparty: e.senderNametag ?? e.senderPubkey,
      deskGetsCoin: e.deal.partyACurrency,
      deskGetsAmount: BigInt(e.deal.partyAAmount),
      deskGivesCoin: e.deal.partyBCurrency,
      deskGivesAmount: BigInt(e.deal.partyBAmount),
      timeoutSec: e.deal.timeout,
    };

    const eff = await this.neg.onProposalReceived(proposal);
    for (const line of eff.logs) this.log(line);
    try {
      if (eff.acceptSwap) {
        // Pre-lock check before committing on-chain; release reservation if it fails.
        const ok = await this.preLockOk(
          proposal.swapId, proposal.counterparty, proposal.deskGetsCoin, proposal.deskGetsAmount,
        );
        if (!ok) {
          this.react(this.neg.onSwapFailed(proposal.swapId, 'pre-lock verification failed'));
          await this.sphere.swap!.rejectSwap(proposal.swapId, 'counterparty verification failed');
          this.record('proposal_rejected', { swapId: proposal.swapId, counterparty: proposal.counterparty, reason: 'unverified' });
        } else {
          await this.sphere.swap!.acceptSwap(eff.acceptSwap.swapId);
          this.record('proposal_accepted', {
            swapId: proposal.swapId,
            counterparty: proposal.counterparty,
            deskGivesCoin: proposal.deskGivesCoin,
            deskGivesAmount: proposal.deskGivesAmount,
            deskGetsCoin: proposal.deskGetsCoin,
            deskGetsAmount: proposal.deskGetsAmount,
          });
        }
      }
      if (eff.rejectSwap) {
        await this.sphere.swap!.rejectSwap(eff.rejectSwap.swapId, eff.rejectSwap.reason);
        this.record('proposal_rejected', {
          swapId: proposal.swapId,
          counterparty: proposal.counterparty,
          reason: eff.rejectSwap.reason,
        });
      }
    } catch (err) {
      // On-chain accept/reject failed — release the reservation we just made.
      if (eff.acceptSwap) this.react(this.neg.onSwapFailed(proposal.swapId, `acceptSwap failed: ${String(err)}`));
      this.log(`proposal ${e.swapId} action error: ${String(err)}`);
    }
    this.auditKillTransition();
    this.persister.schedule();
  }

  /**
   * Proposer lock: the escrow acknowledged the manifest. Run the pre-lock check
   * on the counterparty's leg, then pay our deposit (= lock our own token). If
   * verification fails, abort the swap and release our reservation rather than
   * lock against an unverifiable counterparty.
   */
  private async onAnnounced(swapId: string): Promise<void> {
    const rfqId = this.neg.rfqIdForSwap(swapId);
    const terms = rfqId ? this.neg.termsFor(rfqId) : undefined;
    if (rfqId && terms) {
      const ok = await this.preLockOk(swapId, terms.counterparty, terms.deskGetsCoin, terms.deskGetsAmount);
      if (!ok) {
        this.react(this.neg.onSwapFailed(rfqId, 'pre-lock verification failed'));
        await this.sphere.swap!.cancelSwap(swapId).catch(() => undefined);
        this.log(`aborted swap ${swapId} — counterparty failed pre-lock check`);
        return;
      }
    }
    try {
      await this.sphere.swap!.deposit(swapId);
      if (rfqId) this.inventory.markDeposited(rfqId);
      this.record('deposit_sent', { swapId });
      this.persister.schedule();
    } catch (err) {
      this.log(`deposit error for ${swapId}: ${String(err)}`);
    }
  }

  /**
   * After a restart, bring every agreed-but-unsettled deal back in sync with the
   * escrow. Sessions whose swap was never opened are aborted; terminal swaps are
   * settled/released; in-flight swaps are left for the SDK's own resume + events.
   */
  async reconcile(): Promise<void> {
    const open = this.neg.agreedSessions();
    if (open.length === 0) return;
    this.log(`reconciling ${open.length} in-flight deal(s) after restart…`);

    for (const { rfqId, swapId } of open) {
      if (!swapId) {
        // Crash between reserve and proposeSwap — no swap exists; abort cleanly.
        this.react(this.neg.onSwapFailed(rfqId, 'no swap opened before restart'));
        continue;
      }
      try {
        const ref = await this.sphere.swap!.getSwapStatus(swapId, { queryEscrow: true });
        switch (ref.progress) {
          case 'completed':
            this.react(this.neg.onSwapCompleted(rfqId));
            break;
          case 'cancelled':
          case 'failed':
            this.react(this.neg.onSwapFailed(rfqId, `reconciled ${ref.progress}`));
            break;
          default:
            this.log(`swap ${swapId} still ${ref.progress} — leaving to SDK resume`);
        }
      } catch (err) {
        this.log(`reconcile error for ${swapId}: ${String(err)} — leaving reservation intact`);
      }
    }
    await this.persister.flush();
  }

  /**
   * Periodically reconcile the ledger's free balances against the chain to
   * correct drift (change tokens, fees, out-of-band receipts). Returns a stop fn.
   */
  /** Pull pending incoming transfers, then reconcile the ledger against chain. */
  private async pullAndReconcile(): Promise<void> {
    await this.sphere.payments.receive().catch(() => undefined);
    const chain = new Map<string, bigint>();
    for (const asset of this.sphere.payments.getBalance()) {
      const coin = this.symbolToCoin[asset.symbol];
      if (coin) chain.set(coin, BigInt(asset.totalAmount));
    }
    const changes = this.inventory.trueUp(chain);
    if (changes.length > 0) {
      for (const c of changes) this.log(c);
      this.record('ledger_trueup', { changes });
      this.persister.schedule();
    }
  }

  startTrueUp(intervalMs: number): () => void {
    const timer = setInterval(
      () => void this.pullAndReconcile().catch((e) => this.log(`true-up error: ${String(e)}`)),
      intervalMs,
    );
    return () => clearInterval(timer);
  }

  /**
   * Reset the rolling per-counterparty daily limits at each UTC midnight.
   * Returns a stop fn. The first fire is aligned to the next midnight; after
   * that it repeats every 24h.
   */
  startDailyReset(): () => void {
    let interval: ReturnType<typeof setInterval> | null = null;
    const reset = (): void => {
      this.inventory.rollDay();
      this.record('limits_rolled', { at: new Date().toISOString() });
      this.persister.schedule();
      this.log('daily counterparty limits reset');
    };
    const now = new Date();
    const nextMidnight = Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0,
    );
    const firstDelay = nextMidnight - now.getTime();
    const timeout = setTimeout(() => {
      reset();
      interval = setInterval(reset, 24 * 60 * 60 * 1000);
    }, firstDelay);
    return () => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
  }

  /**
   * Mark all inventory to the numéraire and trip the kill-switch if the day's
   * mark-to-market loss reaches the limit. Returns a stop fn. A mark with any
   * unpriceable coin is skipped rather than acted on.
   */
  startPnlGuard(intervalMs: number): () => void {
    // Numéraire = the shared quote coin of the configured pairs.
    const numeraire = [...this.pairs.values()][0]?.quote;
    const baseByCoin = new Map<string, PairSpec>();
    const decimalsByCoin = new Map<string, number>();
    for (const p of this.pairs.values()) {
      baseByCoin.set(p.base.coinId, p);
      decimalsByCoin.set(p.base.coinId, p.base.decimals);
      decimalsByCoin.set(p.quote.coinId, p.quote.decimals);
    }

    const tick = async (): Promise<void> => {
      if (!numeraire) return;
      const balances = this.inventory.freeBalances();
      const holdings: Holding[] = [];
      const mids = new Map<string, bigint>();
      for (const [coin, amount] of balances) {
        if (amount === 0n) continue;
        const decimals = decimalsByCoin.get(coin);
        if (decimals === undefined) return; // unknown coin held → can't mark fully
        holdings.push({ coin, amount, decimals });
        if (coin !== numeraire.coinId) {
          const pair = baseByCoin.get(coin)!;
          const mid = await this.priceFeed.midScaled(pair.base.symbol, numeraire.symbol);
          if (mid === null) return; // missing price → skip this tick
          mids.set(coin, mid);
        }
      }

      const equity = markToNumeraire(holdings, mids, { coin: numeraire.coinId, decimals: numeraire.decimals });
      if (equity === null) return;

      const utcDay = new Date().toISOString().slice(0, 10);
      const { dailyPnl, breach, rebaselined } = this.pnl.mark(equity, utcDay);
      // Only audit when P&L actually moves (or on breach/rebaseline) — avoids
      // flooding the log with identical flat marks every tick.
      if (breach || rebaselined || dailyPnl !== this.lastPnlRecorded) {
        this.record('pnl_mark', { equity, dailyPnl, day: utcDay, rebaselined });
        this.lastPnlRecorded = dailyPnl;
      }
      if (breach && !this.killSwitch.isHalted()) {
        this.killSwitch.halt(`P&L breaker: daily loss ${-dailyPnl} ${numeraire.symbol} ≥ limit`);
        this.log(`*** P&L BREAKER TRIPPED — daily loss ${-dailyPnl} ${numeraire.symbol} ***`);
      }
      this.auditKillTransition();
      this.persister.schedule();
    };

    void tick();
    const timer = setInterval(() => void tick(), intervalMs);
    return () => clearInterval(timer);
  }

  private async onDm(peer: string, content: string): Promise<void> {
    const msg = parseWire(content);
    if (!msg) return; // not a structured desk message — an LLM layer would handle NL here
    const effects = await this.neg.handle(peer, msg);
    for (const line of effects.logs) this.log(line);
    this.auditDmEffects(peer, effects);
    for (const reply of effects.replies) {
      await this.sphere.communications.sendDM(peer, JSON.stringify(reply));
    }
    if (effects.startSwap) await this.openSwap(effects.startSwap);
    this.auditKillTransition();
    this.persister.schedule();
  }

  /** Audit the money-relevant outcomes of a negotiation step. */
  private auditDmEffects(peer: string, e: Effects): void {
    for (const r of e.replies) {
      if (r.t === 'quote') {
        this.record('quote_issued', {
          rfqId: r.rfqId, peer, side: r.side, base: r.base, baseAmount: r.baseAmount,
          quote: r.quote, quoteAmount: r.quoteAmount, priceScaled: r.priceScaled,
        });
      } else if (r.t === 'reject') {
        this.record('rfq_rejected', { rfqId: r.rfqId, peer, reason: r.reason ?? '' });
      }
    }
    if (e.startSwap) {
      this.record('deal_agreed', {
        rfqId: e.startSwap.rfqId, counterparty: e.startSwap.counterparty,
        deskGivesCoin: e.startSwap.deskGivesCoin, deskGivesAmount: e.startSwap.deskGivesAmount,
        deskGetsCoin: e.startSwap.deskGetsCoin, deskGetsAmount: e.startSwap.deskGetsAmount,
      });
    }
  }

  /** Swap-event reaction: log, persist, and audit any kill-switch transition. */
  private react(e: Effects): void {
    for (const line of e.logs) this.log(line);
    this.auditKillTransition();
    this.persister.schedule();
  }

  private async openSwap(terms: SwapTerms): Promise<void> {
    const identity = this.sphere.identity;
    if (!identity?.directAddress) throw new Error('desk identity not initialized');

    const result = await this.sphere.swap!.proposeSwap(
      {
        partyA: identity.directAddress,
        partyB: terms.counterparty,
        partyACurrency: terms.deskGivesCoin,
        partyAAmount: terms.deskGivesAmount.toString(),
        partyBCurrency: terms.deskGetsCoin,
        partyBAmount: terms.deskGetsAmount.toString(),
        timeout: terms.timeoutSec,
        escrowAddress: this.escrow,
      },
      { message: `OTC settlement for ${terms.rfqId}` },
    );

    // Bind swapId to the session and persist immediately so a crash right after
    // proposeSwap can still route the swap's events back on restart.
    this.neg.attachSwap(terms.rfqId, result.swapId);
    await this.persister.flush();
    this.record('swap_proposed', { rfqId: terms.rfqId, swapId: result.swapId });
    this.log(`swap proposed ${result.swapId} for rfq ${terms.rfqId}`);
  }
}

/** Tolerant parse: returns null for anything that isn't a known WireMsg. */
export function parseWire(content: string): WireMsg | null {
  try {
    const o = JSON.parse(content) as { t?: unknown; rfqId?: unknown };
    if (typeof o.t !== 'string' || typeof o.rfqId !== 'string') return null;
    if (['rfq', 'quote', 'accept', 'counter', 'reject'].includes(o.t)) return o as WireMsg;
    return null;
  } catch {
    return null;
  }
}
