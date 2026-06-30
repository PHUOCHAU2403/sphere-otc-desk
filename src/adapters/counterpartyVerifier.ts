/**
 * Counterparty token verification — the on-chain side of the pre-lock check.
 * Behind an interface so the domain stays pure and the implementation is
 * swappable (real SDK / stub / always-ok for sim).
 *
 * The ideal check (per docs/SETTLEMENT-MODEL.md) is: the counterparty actually
 * controls the token they're offering, and its source state is unspent (a
 * non-inclusion proof from the uniqueness service). That deeper proof needs a
 * uniqueness-service primitive not yet confirmed in the SDK; until then the
 * Sphere implementation enforces what it *can* confirm — that the counterparty
 * identity resolves — and flags the rest as pending.
 */

import type { Sphere } from '@unicitylabs/sphere-sdk';
import type { CounterpartyVerification } from '../domain/prelock.js';

export interface CounterpartyVerifier {
  /** Verify the counterparty can deliver `amount` of `coin`. */
  verify(party: string, coin: string, amount: bigint): Promise<CounterpartyVerification>;
}

/** Always passes — for the sim and offline tests. */
export class NullCounterpartyVerifier implements CounterpartyVerifier {
  async verify(): Promise<CounterpartyVerification> {
    return { ok: true, reason: 'verification skipped' };
  }
}

export class SphereCounterpartyVerifier implements CounterpartyVerifier {
  constructor(private readonly sphere: Sphere) {}

  async verify(party: string, coin: string, amount: bigint): Promise<CounterpartyVerification> {
    void coin;
    void amount;
    // 1. Identity must resolve — a peer we can't resolve can't be transacted with.
    const peer = await this.sphere.resolve(party).catch(() => null);
    if (!peer) return { ok: false, reason: `counterparty ${party} does not resolve` };

    // 2. TODO: ownership + non-inclusion proof of the counterparty's source token
    //    state, once the uniqueness-service primitive is confirmed in the SDK.
    //    See docs/SETTLEMENT-MODEL.md (residual risk #2).
    return { ok: true, reason: 'identity resolved; token non-inclusion check pending SDK primitive' };
  }
}
