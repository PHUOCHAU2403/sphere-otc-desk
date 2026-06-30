/**
 * Inventory + risk ledger. Single source of truth for "can the desk afford this
 * deal, and is it allowed to". Deterministic and in-memory; persisted between
 * restarts via toSnapshot()/restore(). In live mode the chain is authoritative
 * for *balances* (re-synced on boot) — reservations/limits come from the snapshot.
 */

export interface RiskLimits {
  /** Max notional (in a chosen reference coin's smallest units) per counterparty per day. */
  readonly perCounterpartyDaily: bigint;
  /** Max total open notional the desk will carry. */
  readonly maxOpenExposure: bigint;
}

/** A leg set aside for an agreed deal, with everything needed to settle/release it. */
interface Reservation {
  readonly coin: string;
  readonly amount: bigint;
  readonly counterparty: string;
  readonly notional: bigint;
  /** True once the leg has been deposited to escrow (left the wallet on-chain). */
  deposited: boolean;
}

export interface InventorySnapshot {
  readonly balances: Record<string, string>;
  readonly reserved: Record<
    string,
    { coin: string; amount: string; counterparty: string; notional: string; deposited: boolean }
  >;
  readonly daily: Record<string, string>;
  readonly openExposure: string;
}

export class Inventory {
  /** coin -> available (free) smallest units. */
  private readonly balances = new Map<string, bigint>();
  /** rfqId -> what we have set aside pending settlement. */
  private readonly reserved = new Map<string, Reservation>();
  /** counterparty -> notional traded today (reference units). */
  private readonly dailyByCounterparty = new Map<string, bigint>();
  private openExposure = 0n;

  constructor(private readonly limits: RiskLimits) {}

  /** Sync free balance from on-chain (call after sphere.payments.getBalance()). */
  setBalance(coin: string, amount: bigint): void {
    this.balances.set(coin, amount);
  }

  available(coin: string): bigint {
    return this.balances.get(coin) ?? 0n;
  }

  /** Snapshot of free balances per coin (for marking equity). */
  freeBalances(): Map<string, bigint> {
    return new Map(this.balances);
  }

  /** Free balance can cover an outgoing leg of `amount` of `coin`. */
  canCover(coin: string, amount: bigint): boolean {
    return this.available(coin) >= amount;
  }

  withinCounterpartyLimit(counterparty: string, notional: bigint): boolean {
    const used = this.dailyByCounterparty.get(counterparty) ?? 0n;
    return used + notional <= this.limits.perCounterpartyDaily;
  }

  withinExposureLimit(notional: bigint): boolean {
    return this.openExposure + notional <= this.limits.maxOpenExposure;
  }

  hasReservation(rfqId: string): boolean {
    return this.reserved.has(rfqId);
  }

  /**
   * Reserve the outgoing leg for a deal we just agreed. Prevents double-spending
   * inventory across concurrent negotiations. Idempotent per rfqId.
   */
  reserve(rfqId: string, coin: string, amount: bigint, counterparty: string, notional: bigint): void {
    if (this.reserved.has(rfqId)) return;
    this.balances.set(coin, this.available(coin) - amount);
    this.reserved.set(rfqId, { coin, amount, counterparty, notional, deposited: false });
    this.openExposure += notional;
    this.dailyByCounterparty.set(
      counterparty,
      (this.dailyByCounterparty.get(counterparty) ?? 0n) + notional,
    );
  }

  /** Mark a reservation's leg as deposited (it has left the wallet on-chain). */
  markDeposited(rfqId: string): void {
    const r = this.reserved.get(rfqId);
    if (r) r.deposited = true;
  }

  /**
   * Reconcile free balances against the chain. Drift sources: change tokens,
   * fees, tokens received outside the desk flow. The invariant is:
   *
   *   free[coin] = chainTotal[coin] − Σ reservations still sitting in the wallet
   *
   * A reservation that hasn't been deposited yet is still counted in the chain
   * total, so we subtract it; a deposited leg already left the wallet, so we
   * don't. Returns a human log of any coin whose free balance changed.
   */
  trueUp(chainTotals: Map<string, bigint>): string[] {
    const undeposited = new Map<string, bigint>();
    for (const r of this.reserved.values()) {
      if (!r.deposited) undeposited.set(r.coin, (undeposited.get(r.coin) ?? 0n) + r.amount);
    }
    const changes: string[] = [];
    for (const [coin, total] of chainTotals) {
      const expected = total - (undeposited.get(coin) ?? 0n);
      const current = this.available(coin);
      if (expected !== current) {
        if (expected < 0n) {
          changes.push(`WARN ${coin}: chain ${total} < pending reservations — skipping true-up`);
          continue;
        }
        changes.push(`true-up ${coin}: ${current} → ${expected} (drift ${expected - current})`);
        this.balances.set(coin, expected);
      }
    }
    return changes;
  }

  /** Deal settled: drop the reservation, credit the incoming leg. */
  settle(rfqId: string, incomingCoin: string, incomingAmount: bigint): void {
    const r = this.reserved.get(rfqId);
    if (!r) return;
    this.reserved.delete(rfqId);
    this.openExposure -= r.notional;
    this.balances.set(incomingCoin, this.available(incomingCoin) + incomingAmount);
  }

  /** Deal fell through: return the reserved leg to free balance. */
  release(rfqId: string): void {
    const r = this.reserved.get(rfqId);
    if (!r) return;
    this.reserved.delete(rfqId);
    this.openExposure -= r.notional;
    this.balances.set(r.coin, this.available(r.coin) + r.amount);
  }

  /** Reset rolling daily counters (call at UTC midnight in a scheduler). */
  rollDay(): void {
    this.dailyByCounterparty.clear();
  }

  // --- persistence ---

  toSnapshot(): InventorySnapshot {
    return {
      balances: Object.fromEntries([...this.balances].map(([k, v]) => [k, v.toString()])),
      reserved: Object.fromEntries(
        [...this.reserved].map(([k, r]) => [
          k,
          {
            coin: r.coin,
            amount: r.amount.toString(),
            counterparty: r.counterparty,
            notional: r.notional.toString(),
            deposited: r.deposited,
          },
        ]),
      ),
      daily: Object.fromEntries([...this.dailyByCounterparty].map(([k, v]) => [k, v.toString()])),
      openExposure: this.openExposure.toString(),
    };
  }

  static restore(limits: RiskLimits, snap: InventorySnapshot): Inventory {
    const inv = new Inventory(limits);
    for (const [coin, v] of Object.entries(snap.balances)) inv.balances.set(coin, BigInt(v));
    for (const [rfqId, r] of Object.entries(snap.reserved)) {
      inv.reserved.set(rfqId, {
        coin: r.coin,
        amount: BigInt(r.amount),
        counterparty: r.counterparty,
        notional: BigInt(r.notional),
        deposited: r.deposited ?? false,
      });
    }
    for (const [cp, v] of Object.entries(snap.daily)) inv.dailyByCounterparty.set(cp, BigInt(v));
    inv.openExposure = BigInt(snap.openExposure);
    return inv;
  }

  snapshot(): { balances: Record<string, string>; openExposure: string } {
    return {
      balances: Object.fromEntries([...this.balances].map(([k, v]) => [k, v.toString()])),
      openExposure: this.openExposure.toString(),
    };
  }
}
