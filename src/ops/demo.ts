/**
 * Populate a realistic sample (snapshot + audit log) and render the dashboard,
 * so you can see/screenshot it without a testnet.
 *   npx tsx src/ops/demo.ts   (or `npm run dashboard:demo`)
 */

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildDesk } from '../deskConfig.js';
import { FileAuditLog } from '../adapters/fileAuditLog.js';
import { generateDashboard } from './generate.js';
import type { DeskSnapshot } from '../domain/persistence.js';

const DIR = './demo';
const STATE = join(DIR, 'desk-state.json');
const AUDIT = join(DIR, 'audit.jsonl');
const OUT = join(DIR, 'dashboard.html');

const uct = (n: number): string => (BigInt(n) * 10n ** 8n).toString();

async function buildSnapshot(): Promise<void> {
  const desk = buildDesk();
  const neg = desk.negotiation;

  // A settled deal (contributes to inventory + audit, drops from open list).
  await neg.handle('@whale', { t: 'rfq', rfqId: 'A1', side: 'buy', base: 'UCT', baseAmount: uct(500) });
  await neg.handle('@whale', { t: 'accept', rfqId: 'A1' });
  neg.attachSwap('A1', 'swap-a1c0ffee1234');
  neg.onSwapCompleted('A1');

  // An in-flight (agreed) deal — reserved inventory, open.
  await neg.handle('@maker', { t: 'rfq', rfqId: 'A2', side: 'buy', base: 'UCT', baseAmount: uct(300) });
  await neg.handle('@maker', { t: 'accept', rfqId: 'A2' });
  neg.attachSwap('A2', 'swap-a2deadbeef99');

  // A live quote awaiting the counterparty.
  await neg.handle('@taker', { t: 'rfq', rfqId: 'Q1', side: 'sell', base: 'UCT', baseAmount: uct(200) });

  // Seed a P&L baseline so the dashboard shows a day's mark.
  desk.pnl.mark(262_500_000000n, new Date().toISOString().slice(0, 10));

  const snapshot: DeskSnapshot = {
    version: 1,
    updatedAt: Date.now(),
    inventory: desk.inventory.toSnapshot(),
    sessions: desk.negotiation.toSnapshot(),
    killSwitch: desk.killSwitch.toSnapshot(),
    pnl: desk.pnl.toSnapshot(),
  };
  await writeFile(STATE, JSON.stringify(snapshot, null, 2), 'utf8');
}

async function buildAudit(): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const a = new FileAuditLog(AUDIT);
  await a.append('boot', { identity: '@otc-desk' });
  await a.append('quote_issued', { rfqId: 'A1', base: 'UCT', baseAmount: uct(500), priceScaled: '125625000', quote: 'USDU', quoteAmount: '628125000' });
  await a.append('deal_agreed', { rfqId: 'A1', counterparty: '@whale' });
  await a.append('swap_proposed', { rfqId: 'A1', swapId: 'swap-a1c0ffee1234' });
  await a.append('deposit_sent', { swapId: 'swap-a1c0ffee1234' });
  await a.append('swap_completed', { swapId: 'swap-a1c0ffee1234', payoutVerified: true });
  await a.append('quote_issued', { rfqId: 'A2', base: 'UCT', baseAmount: uct(300), priceScaled: '125625000', quote: 'USDU', quoteAmount: '376875000' });
  await a.append('deal_agreed', { rfqId: 'A2', counterparty: '@maker' });
  await a.append('swap_proposed', { rfqId: 'A2', swapId: 'swap-a2deadbeef99' });
  await a.append('deposit_sent', { swapId: 'swap-a2deadbeef99' });
  await a.append('proposal_accepted', { swapId: 'swap-arb55aa11bb22', counterparty: '@arb-bot', deskGivesCoin: 'USDU', deskGivesAmount: '248000000', deskGetsCoin: 'UCT', deskGetsAmount: uct(200) });
  await a.append('rfq_rejected', { rfqId: 'B7', peer: '@whale', reason: 'SIZE_TOO_LARGE' });
  await a.append('swap_failed', { swapId: 'swap-bad9911', rfqId: 'X3', error: 'escrow timeout' });
  await a.append('ledger_trueup', { changes: ['true-up UCT: 970000000000 → 970010000000 (drift 10000000)'] });
  await a.append('pnl_mark', { equity: '262500000000', dailyPnl: '0', day, rebaselined: true });
  await a.append('pnl_mark', { equity: '260650000000', dailyPnl: '-1850000000', day, rebaselined: false });
  await a.close();
}

async function main(): Promise<void> {
  await rm(DIR, { recursive: true, force: true }); // reproducible: start clean
  await mkdir(DIR, { recursive: true });
  await buildSnapshot();
  await buildAudit();
  await generateDashboard(STATE, AUDIT, OUT);
  console.log(`demo dashboard → ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
