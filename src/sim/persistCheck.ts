/**
 * Proves restart-safety: an agreed deal (reserved inventory + in-flight session)
 * survives a process restart and still settles correctly. No SDK, no network.
 *   npx tsx src/sim/persistCheck.ts
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { buildDesk } from '../deskConfig.js';
import { KillSwitch } from '../domain/killSwitch.js';
import { FileStore } from '../adapters/fileStore.js';
import type { DeskSnapshot } from '../domain/persistence.js';

let pass = true;
function check(label: string, cond: boolean): void {
  console.log(`   ${cond ? '✓' : '✗ FAIL'}  ${label}`);
  if (!cond) pass = false;
}

function capture(desk: ReturnType<typeof buildDesk>): DeskSnapshot {
  return {
    version: 1,
    updatedAt: Date.now(),
    inventory: desk.inventory.toSnapshot(),
    sessions: desk.negotiation.toSnapshot(),
    killSwitch: desk.killSwitch.toSnapshot(),
  };
}

async function main(): Promise<void> {
  const path = join(tmpdir(), `otc-persist-${process.pid}.json`);
  const store = new FileStore(path);
  const now = (): number => 1_700_000_000_000;
  const SWAP_ID = 'swap-deadbeef';

  // ── Before crash: take a deal to 'agreed' and persist ───────────────────
  console.log('\n[1] desk A — open a deal, reserve inventory, persist');
  const a = buildDesk({ now });
  const before = a.inventory.snapshot();

  await a.negotiation.handle('@whale', {
    t: 'rfq', rfqId: 'P1', side: 'buy', base: 'UCT', baseAmount: (500n * 10n ** 8n).toString(),
  });
  const accept = await a.negotiation.handle('@whale', { t: 'accept', rfqId: 'P1' });
  check('accept produced startSwap', accept.startSwap !== undefined);
  a.negotiation.attachSwap('P1', SWAP_ID); // adapter does this after proposeSwap
  await store.save(capture(a));

  const afterReserve = a.inventory.snapshot();
  check('UCT reserved (free balance dropped 500)',
    BigInt(before.balances['UCT']!) - BigInt(afterReserve.balances['UCT']!) === 500n * 10n ** 8n);
  check('open exposure > 0', BigInt(afterReserve.openExposure) > 0n);

  // ── Simulate crash + restart: rebuild purely from the snapshot ──────────
  console.log('\n[2] desk B — fresh process, restore from disk');
  const snap = await store.load();
  check('snapshot loaded', snap !== null);
  const b = buildDesk({ now, snapshot: snap! });

  const restored = b.inventory.snapshot();
  check('restored free balances match pre-crash', restored.balances['UCT'] === afterReserve.balances['UCT']);
  check('restored open exposure matches', restored.openExposure === afterReserve.openExposure);
  check('reservation survived', b.inventory.hasReservation('P1'));

  const agreed = b.negotiation.agreedSessions();
  check('in-flight session restored', agreed.length === 1 && agreed[0]!.rfqId === 'P1');
  check('swapId restored', agreed[0]!.swapId === SWAP_ID);
  check('swap→rfq mapping works', b.negotiation.rfqIdForSwap(SWAP_ID) === 'P1');

  // ── Swap completes on the restored desk: inventory settles correctly ────
  console.log('\n[3] desk B — swap completes after restart');
  const rfqId = b.negotiation.rfqIdForSwap(SWAP_ID)!;
  b.negotiation.onSwapCompleted(rfqId);
  const settled = b.inventory.snapshot();
  check('reservation cleared after settle', !b.inventory.hasReservation('P1'));
  check('open exposure back to zero', settled.openExposure === '0');
  check('USDU credited (received quote leg)',
    BigInt(settled.balances['USDU']!) > BigInt(before.balances['USDU']!));

  console.log(`     UCT ${fmt(settled.balances['UCT'], 8)}  USDU ${fmt(settled.balances['USDU'], 6)}`);

  // ── Kill-switch state survives a restart (latched halt) ─────────────────
  console.log('\n[4] kill-switch state persists across restart');
  b.killSwitch.halt('manual test halt');
  await store.save(capture(b));
  const snap2 = await store.load();
  const c = buildDesk({
    now,
    snapshot: snap2!,
    killSwitch: KillSwitch.restore({ maxConsecutiveFailures: 3 }, snap2!.killSwitch!),
  });
  check('restored desk boots halted', c.killSwitch.isHalted());
  check('halt reason preserved', c.killSwitch.reason() === 'manual test halt');

  await rm(path, { force: true });
  console.log(`\n${pass ? '✓ ALL CHECKS PASSED' : '✗ SOME CHECKS FAILED'}\n`);
  if (!pass) process.exit(1);
}

const fmt = (v: string | undefined, dp: number): string => (Number(v ?? '0') / 10 ** dp).toFixed(4);

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
