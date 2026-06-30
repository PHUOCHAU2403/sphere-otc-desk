/**
 * Pre-lock policy — the cheap, deterministic checks the desk runs *before* it
 * locks its own token into a swap. Covers the residual (non-custodial) risks
 * from docs/SETTLEMENT-MODEL.md:
 *
 *   - timeout too short → late-lock hazard (we might fail to lock in time)
 *   - timeout too long  → our liquidity is held hostage if the peer never locks
 *   - counterparty token unverified → they may have offered an unowned/spent token
 *
 * Pure. The expensive part (on-chain ownership + non-inclusion proof) is done by
 * the adapter's CounterpartyVerifier; this module only consumes its result.
 */

export interface PreLockBounds {
  /** Reject swaps whose timeout is below this — too little margin to lock safely. */
  readonly minTimeoutSec: number;
  /** Reject swaps whose timeout is above this — too long to tie up inventory. */
  readonly maxTimeoutSec: number;
}

/** Result of the adapter's on-chain counterparty check. */
export interface CounterpartyVerification {
  readonly ok: boolean;
  readonly reason: string;
}

export type PreLockDecision = { ok: true } | { ok: false; reason: string };

export function timeoutWithinBounds(timeoutSec: number, b: PreLockBounds): boolean {
  return timeoutSec >= b.minTimeoutSec && timeoutSec <= b.maxTimeoutSec;
}

/**
 * Final gate before locking: honour the counterparty verification unless
 * verification is disabled. (Timeout bounds are enforced earlier, in the quote
 * engine, so a bad-timeout proposal is rejected before any inventory is reserved.)
 */
export function gateOnVerification(
  v: CounterpartyVerification,
  requireVerification: boolean,
): PreLockDecision {
  if (requireVerification && !v.ok) {
    return { ok: false, reason: `counterparty unverified: ${v.reason}` };
  }
  return { ok: true };
}
