# Settlement model — findings

> **Scope note.** This document analyses the protocol's **native** `sphere.swap`
> settlement — the *target* model. It is **not yet migrated to testnet2** (the
> Unicity team confirmed this; native escrow ETA "this year"), so the shipped
> desk currently settles through its **own escrow agent** (escrow-based; see the
> *Settlement* section of the README). This analysis is why native settlement is
> the roadmap: when it lands, the desk swaps back with no change to negotiation
> or risk.

**Question we were blocked on:** is `sphere.swap` settled by a trusted custodian
(escrow that holds funds), or is it trust-minimized?

**Answer: it is non-custodial and trustless — proven.** Source: Unicity's formal
paper *"Predicates and Atomic Swaps"* (`unicitynetwork/unicity-predicates-tex`,
§ Atomic Swap in the Unicity Infrastructure), corroborated by the protocol deck
(slide 18, "Unicity Trustless Atomic Swap").

## How the swap actually works

- Each party moves its **own** token between states defined by predicates it
  controls: signature state → swap (lock) state → finalized/rolled-back. **No
  third party ever holds the tokens.**
- The "Unicity Service" (`unisrv`) is an **append-only key/value uniqueness
  registry** that records single-spend commitments and returns inclusion proofs.
  It holds no tokens, cannot pay itself, cannot selectively block (non-blocking
  security is proven). This is the uniqueness oracle / aggregator — the "shared
  reference," not a custodian.
- The **swap predicate** encodes both-or-nothing cryptographically: party A's
  locked token is claimable by B *iff* B committed in time — proven by an
  inclusion proof that `R[k_B] = v_B_swap` — and otherwise reverts to A after
  `τ_max`. Symmetric for B.
- **Proven guarantees:** (1) both follow the protocol → tokens change hands;
  (2) either deviates → both keep their tokens after the timeout. Holds even
  under unconditional network delays — the explicit advantage over HTLC, whose
  "timing trap" (claim-before-timeout race / free option) this design removes.

## Mapping to the SDK (`sphere.swap`)

| Paper | SDK term |
|---|---|
| Phase 0 — off-band parameter agreement (`pubkeys`, `τ_max`) | `proposeSwap` + content-addressed manifest, `acceptSwap` |
| Phase 1 — **lock**: transfer *your own* token into the swap state | `deposit` (state `depositing`) — **not** sending funds to a custodian |
| `τ_max` | `SwapDeal.timeout` |
| Phase 2 — finalize: claim counterparty's leg via inclusion proof | `concluding → completed` |
| Verify counterparty committed (`R[k']=v'_swap`) | `verifyPayout` / `swap:completed.payoutVerified` |
| Rollback after `τ_max` if counterparty didn't commit | `swap_cancelled` / `deposits_returned` / `bounce` |

So the SDK's "escrow service" wording = a **coordinator / uniqueness-service
interface**, and "deposit" = locking your own token under a swap predicate. There
is no custodial step where an operator could abscond with funds.

## Residual risks (downgraded from custody → liveness/griefing)

These are real but bounded — none is "the operator can steal your money":

1. **Which protocol variant does the SDK use?** The paper gives two:
   - *3-tx (prepare → commit → finalize)* — **unconditionally safe**: the prepare
     predicate rejects any swap transaction after `τ_max`, so late-locking is
     impossible.
   - *2-tx (lock → finalize)* — more efficient but has a **late-locking hazard**:
     if you lock *after* `τ_max` while the counterparty already rolled back, your
     token is permanently unrecoverable (paper, Lemma "Late locking hazard").
   → Confirm the variant from SDK source or with the team. If 2-tx, the desk MUST
   guarantee it locks before `τ_max` (or do nothing after it).

2. **Counterparty offers an unowned / already-spent token.** Mitigated by
   verifying the counterparty's token ownership + a **non-inclusion proof** before
   locking. Check whether `sphere.swap` does this automatically; if not, do it in
   the desk before `deposit`.

3. **Liquidity lock-up (griefing).** A counterparty who agrees then never locks
   leaves the desk's token locked until `τ_max` (opportunity cost, **no fund
   loss**). → Use **short timeouts** on desk swaps.

4. **Uniqueness-service availability.** Locking/finalize/rollback need the
   service. It's decentralized/sharded and the design tolerates delays, but a
   prolonged outage delays settlement. Operational, not custodial.

## Design implications for the desk (already partly reflected)

- Prefer **short `timeout`** (we pass `swapTimeoutSec`; tune it down).
- Before accepting/locking, **verify the counterparty token** (state + non-spent).
- Treat the swap as trust-minimized in risk disclosure — no custodial-default
  warning needed.

## Still worth a quick word with the team (optional, non-blocking)

- Does `sphere.swap` v0.4.x implement the 3-tx (safe) or 2-tx (late-lock hazard)
  variant?
- Does it auto-verify the counterparty's token (ownership + non-inclusion) before
  `deposit`, or should the desk?
- Mainnet uniqueness-service availability / sharding status.
