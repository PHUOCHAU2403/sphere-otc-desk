/**
 * Hardening: multi-venue median price feed + chain↔ledger true-up. No network.
 *   npx tsx src/sim/hardeningCheck.ts
 */

import { buildDesk } from '../deskConfig.js';
import { MedianPriceFeed, StaticPriceFeed } from '../domain/priceFeed.js';
import { Inventory } from '../domain/inventory.js';
import { PRICE_SCALE } from '../domain/quoteEngine.js';
import type { WireMsg } from '../domain/types.js';

let pass = true;
function check(label: string, cond: boolean): void {
  console.log(`   ${cond ? '✓' : '✗ FAIL'}  ${label}`);
  if (!cond) pass = false;
}

const scaled = (n: number): bigint => BigInt(n) * PRICE_SCALE;
const uct = (n: number): bigint => BigInt(n) * 10n ** 8n;

async function median(): Promise<void> {
  console.log('\n[A] MedianPriceFeed — robust to an outlier venue');
  const v1 = new StaticPriceFeed({ 'BTC/USDU': 100 });
  const v2 = new StaticPriceFeed({ 'BTC/USDU': 101 });
  const v3 = new StaticPriceFeed({ 'BTC/USDU': 9999 }); // outlier

  const m3 = new MedianPriceFeed([v1, v2, v3], 2);
  check('odd: median of [100,101,9999] = 101', (await m3.midScaled('BTC', 'USDU')) === scaled(101));

  const m2 = new MedianPriceFeed([v1, v2], 2);
  check('even: median of [100,101] = 100.5', (await m2.midScaled('BTC', 'USDU')) === (scaled(100) + scaled(101)) / 2n);

  const oneLive = new MedianPriceFeed([v1, new StaticPriceFeed({})], 2);
  check('refuses with < minSources (1 live, need 2)', (await oneLive.midScaled('BTC', 'USDU')) === null);
}

async function trueUp(): Promise<void> {
  console.log('\n[B] Inventory.trueUp — corrects drift, respects pending deposits');
  const desk = buildDesk();
  const inv = desk.inventory;

  // Reserve 500 UCT via a buy deal (desk gives base).
  const rfq: WireMsg = { t: 'rfq', rfqId: 'T1', side: 'buy', base: 'UCT', baseAmount: uct(500).toString() };
  await desk.negotiation.handle('@cp', rfq);
  await desk.negotiation.handle('@cp', { t: 'accept', rfqId: 'T1' });
  check('free dropped to 9500 after reserve', inv.available('UCT') === uct(9500));

  // Chain still shows the full 10000 (reserved tokens haven't been deposited).
  let changes = inv.trueUp(new Map([['UCT', uct(10000)]]));
  check('no change when chain matches free + undeposited', changes.length === 0 && inv.available('UCT') === uct(9500));

  // Out-of-band receipt of 10 UCT → true-up lifts free by 10.
  changes = inv.trueUp(new Map([['UCT', uct(10010)]]));
  check('drift corrected up to 9510', changes.length === 1 && inv.available('UCT') === uct(9510));

  // Deposit goes out: mark it, chain drops by the 500 reserved leg.
  inv.markDeposited('T1');
  changes = inv.trueUp(new Map([['UCT', uct(9510)]]));
  check('no change once leg is deposited', changes.length === 0 && inv.available('UCT') === uct(9510));

  // Guard: chain below pending reservations → warn, no corruption.
  inv.release('T1'); // drop deposited flag scenario; re-reserve undeposited
  await desk.negotiation.handle('@cp', { t: 'rfq', rfqId: 'T2', side: 'buy', base: 'UCT', baseAmount: uct(500).toString() });
  await desk.negotiation.handle('@cp', { t: 'accept', rfqId: 'T2' });
  const before = inv.available('UCT');
  changes = inv.trueUp(new Map([['UCT', uct(100)]])); // absurdly low
  check('negative guard: warns and leaves balance untouched',
    changes.some((c) => c.startsWith('WARN')) && inv.available('UCT') === before);
}

function dailyLimits(): void {
  console.log('\n[C] daily counterparty limit consumes then resets on rollDay');
  const inv = new Inventory({ perCounterpartyDaily: 1000n, maxOpenExposure: 10n ** 18n });
  inv.setBalance('UCT', uct(10000));

  check('fresh: within limit', inv.withinCounterpartyLimit('@cp', 1000n));
  inv.reserve('d1', 'UCT', uct(1), '@cp', 1000n); // consume the full daily allowance
  check('after reserve: further notional blocked', !inv.withinCounterpartyLimit('@cp', 1n));
  inv.rollDay();
  check('after rollDay: allowance restored', inv.withinCounterpartyLimit('@cp', 1000n));
}

async function main(): Promise<void> {
  await median();
  await trueUp();
  dailyLimits();
  console.log(`\n${pass ? '✓ ALL CHECKS PASSED' : '✗ SOME CHECKS FAILED'}\n`);
  if (!pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
