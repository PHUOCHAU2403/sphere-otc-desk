/**
 * Safety rails: kill-switch (manual + circuit breaker) and tamper-evident audit.
 * No SDK, no network.
 *   npx tsx src/sim/safetyCheck.ts
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { buildDesk } from '../deskConfig.js';
import { KillSwitch } from '../domain/killSwitch.js';
import { FileAuditLog } from '../adapters/fileAuditLog.js';
import type { NegotiationEngine } from '../domain/negotiation.js';
import type { WireMsg } from '../domain/types.js';

let pass = true;
function check(label: string, cond: boolean): void {
  console.log(`   ${cond ? '✓' : '✗ FAIL'}  ${label}`);
  if (!cond) pass = false;
}

const now = (): number => 1_700_000_000_000;
const rfq = (rfqId: string): WireMsg => ({ t: 'rfq', rfqId, side: 'buy', base: 'UCT', baseAmount: (100n * 10n ** 8n).toString() });
const firstReply = (replies: WireMsg[]): WireMsg | undefined => replies[0];

async function makeAgreed(neg: NegotiationEngine, rfqId: string): Promise<void> {
  await neg.handle('@cp', rfq(rfqId));
  await neg.handle('@cp', { t: 'accept', rfqId });
}

async function killSwitchManual(): Promise<void> {
  console.log('\n[A] manual kill-switch gates new risk');
  const ks = new KillSwitch({ maxConsecutiveFailures: 99 });
  const desk = buildDesk({ now, killSwitch: ks });
  const neg = desk.negotiation;

  ks.halt('manual test');
  const r1 = await neg.handle('@cp', rfq('A1'));
  const rep = firstReply(r1.replies);
  check('RFQ rejected while halted', rep?.t === 'reject' && rep.reason === 'desk paused');

  const prop = await neg.onProposalReceived({
    swapId: 'A-prop', counterparty: '@cp', timeoutSec: 1800,
    deskGivesCoin: 'UCT', deskGivesAmount: 100n * 10n ** 8n,
    deskGetsCoin: 'USDU', deskGetsAmount: 130n * 10n ** 6n,
  });
  check('proposal rejected while halted', prop.rejectSwap?.reason === 'desk paused');

  ks.resume();
  const r2 = await neg.handle('@cp', rfq('A2'));
  check('quotes again after resume', firstReply(r2.replies)?.t === 'quote');
}

async function circuitBreaker(): Promise<void> {
  console.log('\n[B] circuit breaker trips after 3 consecutive swap failures');
  const ks = new KillSwitch({ maxConsecutiveFailures: 3 });
  const desk = buildDesk({ now, killSwitch: ks });
  const neg = desk.negotiation;

  for (const id of ['B1', 'B2']) {
    await makeAgreed(neg, id);
    neg.onSwapFailed(id, 'escrow down');
  }
  check('still running after 2 failures', !ks.isHalted());

  await makeAgreed(neg, 'B3');
  neg.onSwapFailed('B3', 'escrow down');
  check('halted after 3rd failure', ks.isHalted());
  check('reason names the breaker', ks.reason().includes('circuit breaker'));

  const r = await neg.handle('@cp', rfq('B4'));
  const rep = firstReply(r.replies);
  check('new RFQ refused after auto-halt', rep?.t === 'reject' && rep.reason === 'desk paused');

  // A successful swap resets the consecutive counter (but not the latched halt).
  ks.resume();
  await makeAgreed(neg, 'B5');
  neg.onSwapCompleted('B5');
  await makeAgreed(neg, 'B6');
  neg.onSwapFailed('B6', 'one-off');
  check('single failure after success does not trip', !ks.isHalted());
}

async function auditChain(): Promise<void> {
  console.log('\n[C] audit log is hash-chained and tamper-evident');
  const path = join(tmpdir(), `otc-audit-${process.pid}.jsonl`);
  const audit = new FileAuditLog(path);

  await audit.append('deal_agreed', { rfqId: 'X1', amount: 100n * 10n ** 8n }); // bigint ok
  await audit.append('swap_proposed', { rfqId: 'X1', swapId: 'sw1' });
  await audit.append('swap_completed', { swapId: 'sw1', payoutVerified: true });
  await audit.close();

  const v1 = await FileAuditLog.verifyFile(path);
  check('fresh chain verifies', v1.ok && v1.count === 3);

  // Reopen and continue the chain across a "restart".
  const audit2 = new FileAuditLog(path);
  await audit2.append('shutdown', {});
  await audit2.close();
  const v2 = await FileAuditLog.verifyFile(path);
  check('chain continues across reopen', v2.ok && v2.count === 4);

  // Tamper with record #2's data — the recomputed hash won't match.
  const lines = (await readFile(path, 'utf8')).split('\n').filter((l) => l.trim());
  const rec = JSON.parse(lines[1]!) as { data: Record<string, unknown> };
  rec.data['swapId'] = 'TAMPERED';
  lines[1] = JSON.stringify(rec);
  await writeFile(path, lines.join('\n') + '\n', 'utf8');

  const v3 = await FileAuditLog.verifyFile(path);
  check('tampering is detected', !v3.ok && v3.brokenAt === 2);

  await rm(path, { force: true });
}

async function main(): Promise<void> {
  await killSwitchManual();
  await circuitBreaker();
  await auditChain();
  console.log(`\n${pass ? '✓ ALL CHECKS PASSED' : '✗ SOME CHECKS FAILED'}\n`);
  if (!pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
