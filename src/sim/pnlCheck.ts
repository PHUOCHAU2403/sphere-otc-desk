/**
 * P&L breaker: mark-to-market equity and the daily-loss circuit. No SDK, no net.
 *   npx tsx src/sim/pnlCheck.ts
 */

import { buildDesk, UCT, USDU } from '../deskConfig.js';
import { PnlTracker, markToNumeraire, type Holding } from '../domain/pnl.js';
import { PRICE_SCALE } from '../domain/quoteEngine.js';

let pass = true;
function check(label: string, cond: boolean): void {
  console.log(`   ${cond ? '✓' : '✗ FAIL'}  ${label}`);
  if (!cond) pass = false;
}

const midScaled = (n: number): bigint => BigInt(Math.round(n * Number(PRICE_SCALE)));
const usdu = (n: number): bigint => BigInt(n) * 1_000000n;
const num = { coin: USDU.coinId, decimals: USDU.decimals };

function equityAtMid(uctMid: number): bigint {
  const desk = buildDesk(); // UCT 10,000 (8dp) + USDU 250,000 (6dp)
  const holdings: Holding[] = [];
  for (const [coin, amount] of desk.inventory.freeBalances()) {
    holdings.push({ coin, amount, decimals: coin === UCT.coinId ? UCT.decimals : USDU.decimals });
  }
  const mids = new Map([[UCT.coinId, midScaled(uctMid)]]);
  return markToNumeraire(holdings, mids, num)!;
}

function marking(): void {
  console.log('\n[A] markToNumeraire — value inventory in USDU');
  // 9,500 UCT @ 1.25 = 11,875 USDU; + 250,628.125 USDU = 262,503.125 USDU.
  const holdings: Holding[] = [
    { coin: UCT.coinId, amount: 9500n * 10n ** 8n, decimals: 8 },
    { coin: USDU.coinId, amount: 250_628_125000n, decimals: 6 },
  ];
  const eq = markToNumeraire(holdings, new Map([[UCT.coinId, midScaled(1.25)]]), num);
  check('equity = 262,503.125 USDU', eq === 262_503_125000n);

  const missing = markToNumeraire(holdings, new Map(), num);
  check('null when a held coin has no mid', missing === null);
}

function breaker(): void {
  console.log('\n[B] PnlTracker — daily loss trips at the limit (1,000 USDU)');
  const t = new PnlTracker(usdu(1000));
  const day = '2026-06-25';

  const m0 = t.mark(usdu(100_000), day);
  check('first mark sets baseline (pnl 0, rebaselined)', m0.dailyPnl === 0n && m0.rebaselined);

  const m1 = t.mark(usdu(99_500), day);
  check('−500 loss: no breach', m1.dailyPnl === -usdu(500) && !m1.breach);

  const m2 = t.mark(usdu(98_500), day);
  check('−1,500 loss: breach', m2.dailyPnl === -usdu(1500) && m2.breach);

  const m3 = t.mark(usdu(98_000), '2026-06-26');
  check('new UTC day re-baselines (pnl 0)', m3.dailyPnl === 0n && m3.rebaselined);
}

function persistence(): void {
  console.log('\n[C] baseline survives restart within the same day');
  const t = new PnlTracker(usdu(1000));
  t.mark(usdu(100_000), '2026-06-25'); // baseline
  const restored = PnlTracker.restore(usdu(1000), t.toSnapshot());
  const m = restored.mark(usdu(99_200), '2026-06-25');
  check('restored baseline keeps running pnl', m.dailyPnl === -usdu(800) && !m.breach && !m.rebaselined);
}

function endToEnd(): void {
  console.log('\n[D] end-to-end: a mid drop on real desk inventory trips the breaker');
  const t = new PnlTracker(usdu(1000));
  const day = '2026-06-25';
  t.mark(equityAtMid(1.25), day); // baseline at fair mid (equity 262,500 USDU)
  // UCT mid drops 1.25 → 1.15: 10,000 UCT loses 0.10 each = 1,000 USDU.
  const m = t.mark(equityAtMid(1.15), day);
  check('1,000 USDU MtM loss → breach', m.dailyPnl === -usdu(1000) && m.breach);
}

marking();
breaker();
persistence();
endToEnd();
console.log(`\n${pass ? '✓ ALL CHECKS PASSED' : '✗ SOME CHECKS FAILED'}\n`);
if (!pass) process.exit(1);
