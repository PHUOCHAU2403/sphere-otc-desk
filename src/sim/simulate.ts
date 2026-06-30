/**
 * Offline walkthrough of the desk — no SDK, no testnet, no escrow.
 *
 * Drives a scripted counterparty against the real NegotiationEngine + QuoteEngine
 * + Inventory, and fakes the sphere.swap lifecycle so you can watch quoting,
 * risk gating, the quote/counter loop, and inventory reservation/settlement.
 *
 *   npm run sim
 */

import { buildDesk } from '../deskConfig.js';
import { PRICE_SCALE } from '../domain/quoteEngine.js';
import type { NegotiationEngine, Effects } from '../domain/negotiation.js';
import type { WireMsg, SwapTerms } from '../domain/types.js';

// Controllable clock so quotes don't expire mid-walkthrough.
let clock = 1_700_000_000_000;
const now = (): number => clock;

const desk = buildDesk({ now });
const neg = desk.negotiation;

const px = (scaled: bigint): string => (Number(scaled) / Number(PRICE_SCALE)).toFixed(6);
const uct = (n: bigint): string => (Number(n) / 1e8).toFixed(4);
const usdu = (n: bigint): string => (Number(n) / 1e6).toFixed(4);

function hr(title: string): void {
  console.log('\n┌' + '─'.repeat(64));
  console.log('│ ' + title);
  console.log('└' + '─'.repeat(64));
}

function show(e: Effects): void {
  for (const l of e.logs) console.log('   · ' + l);
  for (const r of e.replies) console.log('   → reply ' + describe(r));
}

function describe(m: WireMsg): string {
  switch (m.t) {
    case 'quote':
      return `QUOTE ${m.rfqId} ${m.baseAmount} ${m.base} @ ${px(BigInt(m.priceScaled))} = ${m.quoteAmount} ${m.quote}`;
    case 'reject':
      return `REJECT ${m.rfqId} (${m.reason})`;
    default:
      return `${m.t.toUpperCase()} ${m.rfqId}`;
  }
}

/** Fake the escrow-based atomic swap: announce → deposit → conclude → complete. */
function settleSwap(engine: NegotiationEngine, terms: SwapTerms): void {
  console.log('   ⇅ swap announced → both deposit → escrow concludes → completed');
  console.log(
    `     desk gives ${terms.deskGivesAmount} ${terms.deskGivesCoin}, ` +
      `gets ${terms.deskGetsAmount} ${terms.deskGetsCoin}`,
  );
  show(engine.onSwapCompleted(terms.rfqId));
}

async function step(peer: string, msg: WireMsg): Promise<Effects> {
  console.log(`\n  ${peer} ⇒ ${describe(msg)}`);
  const e = await neg.handle(peer, msg);
  show(e);
  if (e.startSwap) settleSwap(neg, e.startSwap);
  return e;
}

function inv(): void {
  const s = desk.inventory.snapshot();
  console.log(
    `   inventory: UCT=${uct(BigInt(s.balances['UCT'] ?? '0'))} ` +
      `USDU=${usdu(BigInt(s.balances['USDU'] ?? '0'))} ` +
      `openExposure=${usdu(BigInt(s.openExposure))}`,
  );
}

async function main(): Promise<void> {
  console.log('OTC DESK — offline simulation');
  console.log('pair UCT/USDU · mid 1.250000 · half-spread 50bps · maxDeal 1000 UCT');
  inv();

  // ── Scenario A: counterparty BUYS 500 UCT, accepts, settles ──────────────
  hr('A. RFQ buy 500 UCT → quote → accept → atomic swap');
  await step('@whale', { t: 'rfq', rfqId: 'A1', side: 'buy', base: 'UCT', baseAmount: (500n * 10n ** 8n).toString() });
  await step('@whale', { t: 'accept', rfqId: 'A1' });
  inv();

  // ── Scenario B: oversize RFQ is rejected by the risk gate ────────────────
  hr('B. RFQ buy 5000 UCT → rejected (size > maxDeal)');
  await step('@whale', { t: 'rfq', rfqId: 'B1', side: 'buy', base: 'UCT', baseAmount: (5000n * 10n ** 8n).toString() });

  // ── Scenario C: counterparty SELLS 200 UCT, haggles, then agrees ─────────
  // Desk bids 1.243750 (mid 1.25 − 50bps). Seller wants more; desk will concede
  // up to its reservation 1.248750 (mid − floor 10bps) but no further.
  hr('C. RFQ sell 200 UCT → counter 1.252 (over reservation → reject) → counter 1.248 (ok) → settle');
  await step('@maker', { t: 'rfq', rfqId: 'C1', side: 'sell', base: 'UCT', baseAmount: (200n * 10n ** 8n).toString() });
  await step('@maker', { t: 'counter', rfqId: 'C1', priceScaled: (125_200000n).toString() }); // 1.252 — too high
  await step('@maker', { t: 'counter', rfqId: 'C1', priceScaled: (124_800000n).toString() }); // 1.248 — within reservation
  await step('@maker', { t: 'accept', rfqId: 'C1' });
  inv();

  // ── Scenario D: unknown pair ─────────────────────────────────────────────
  hr('D. RFQ for an unlisted pair → rejected');
  await step('@noob', { t: 'rfq', rfqId: 'D1', side: 'buy', base: 'DOGE', baseAmount: '1' });

  console.log('\n✓ simulation complete\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
