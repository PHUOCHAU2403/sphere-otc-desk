/**
 * Acceptor path: the desk evaluates swaps proposed *to* it and auto-accepts or
 * rejects on price + risk. No SDK, no network — drives the domain directly.
 *   npx tsx src/sim/acceptorCheck.ts
 */

import { buildDesk } from '../deskConfig.js';
import type { SwapProposal } from '../domain/types.js';

let pass = true;
function check(label: string, cond: boolean): void {
  console.log(`   ${cond ? '✓' : '✗ FAIL'}  ${label}`);
  if (!cond) pass = false;
}

const now = (): number => 1_700_000_000_000;
const desk = buildDesk({ now });
const neg = desk.negotiation;

const UCT = 'UCT';
const USDU = 'USDU';
const uct = (n: number): bigint => BigInt(n) * 10n ** 8n;
const usdu = (n: number): bigint => BigInt(Math.round(n * 1e6));

async function main(): Promise<void> {
  console.log('ACCEPTOR PATH — mid 1.25, floor 10bps → ask-reservation 1.25125, bid-reservation 1.24875\n');
  const before = desk.inventory.snapshot();

  // A. Counterparty BUYS 300 UCT, offers 1.26 (≥ ask reservation) → accept.
  console.log('[A] proposal: counterparty buys 300 UCT @ 1.26 (good) → accept');
  const good: SwapProposal = {
    swapId: 'S-good', counterparty: '@alpha', timeoutSec: 1800,
    deskGivesCoin: UCT, deskGivesAmount: uct(300),   // desk sells base
    deskGetsCoin: USDU, deskGetsAmount: usdu(378),    // 378/300 = 1.26
  };
  const a = await neg.onProposalReceived(good);
  check('accepted on-chain (acceptSwap emitted)', a.acceptSwap?.swapId === 'S-good');
  check('UCT reserved (free −300)',
    BigInt(before.balances[UCT]!) - BigInt(desk.inventory.snapshot().balances[UCT]!) === uct(300));
  check('session keyed by swapId is agreed', neg.rfqIdForSwap('S-good') === 'S-good');

  // A settles.
  neg.onSwapCompleted('S-good');
  check('USDU credited after settle',
    BigInt(desk.inventory.snapshot().balances[USDU]!) > BigInt(before.balances[USDU]!));
  check('reservation cleared', !desk.inventory.hasReservation('S-good'));

  // B. Counterparty buys 300 UCT but only offers 1.20 (< ask reservation) → reject.
  console.log('\n[B] proposal: buys 300 UCT @ 1.20 (underpriced) → reject');
  const bad: SwapProposal = {
    swapId: 'S-bad', counterparty: '@beta', timeoutSec: 1800,
    deskGivesCoin: UCT, deskGivesAmount: uct(300),
    deskGetsCoin: USDU, deskGetsAmount: usdu(360), // 1.20
  };
  const b = await neg.onProposalReceived(bad);
  check('rejected with PRICE_REJECTED', b.rejectSwap?.reason === 'PRICE_REJECTED');
  check('no reservation made', !desk.inventory.hasReservation('S-bad'));

  // C. Oversize (5000 UCT > maxDeal 1000) → reject.
  console.log('\n[C] proposal: buys 5000 UCT → reject (size)');
  const big: SwapProposal = {
    swapId: 'S-big', counterparty: '@gamma', timeoutSec: 1800,
    deskGivesCoin: UCT, deskGivesAmount: uct(5000),
    deskGetsCoin: USDU, deskGetsAmount: usdu(6300),
  };
  check('rejected SIZE_TOO_LARGE', (await neg.onProposalReceived(big)).rejectSwap?.reason === 'SIZE_TOO_LARGE');

  // D. Unknown pair → reject.
  console.log('\n[D] proposal: unlisted coins → reject (unknown pair)');
  const unknown: SwapProposal = {
    swapId: 'S-doge', counterparty: '@noob', timeoutSec: 1800,
    deskGivesCoin: 'DOGE', deskGivesAmount: 1n,
    deskGetsCoin: 'PEPE', deskGetsAmount: 1n,
  };
  check('rejected UNKNOWN_PAIR', (await neg.onProposalReceived(unknown)).rejectSwap?.reason === 'UNKNOWN_PAIR');

  // E. Counterparty SELLS 200 UCT asking 1.24 (≤ bid reservation) → accept.
  console.log('\n[E] proposal: counterparty sells 200 UCT @ 1.24 (good) → accept');
  const sell: SwapProposal = {
    swapId: 'S-sell', counterparty: '@delta', timeoutSec: 1800,
    deskGivesCoin: USDU, deskGivesAmount: usdu(248), // desk pays quote, 248/200 = 1.24
    deskGetsCoin: UCT, deskGetsAmount: uct(200),
  };
  const e = await neg.onProposalReceived(sell);
  check('accepted', e.acceptSwap?.swapId === 'S-sell');
  check('USDU reserved for buy', desk.inventory.hasReservation('S-sell'));

  // G. Timeout outside the pre-lock window → reject before reserving.
  console.log('\n[G] proposal: timeout 30s (< min 120s) → reject (pre-lock)');
  const fast: SwapProposal = {
    swapId: 'S-fast', counterparty: '@hft', timeoutSec: 30,
    deskGivesCoin: UCT, deskGivesAmount: uct(100),
    deskGetsCoin: USDU, deskGetsAmount: usdu(130),
  };
  const g = await neg.onProposalReceived(fast);
  check('rejected TIMEOUT_OUT_OF_RANGE', g.rejectSwap?.reason === 'TIMEOUT_OUT_OF_RANGE');
  check('no reservation for bad-timeout proposal', !desk.inventory.hasReservation('S-fast'));

  // F. Duplicate proposal is ignored (no double reserve).
  console.log('\n[F] duplicate proposal → ignored');
  const dup = await neg.onProposalReceived(sell);
  check('duplicate produced no action', dup.acceptSwap === undefined && dup.rejectSwap === undefined);

  console.log(`\n${pass ? '✓ ALL CHECKS PASSED' : '✗ SOME CHECKS FAILED'}\n`);
  if (!pass) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
