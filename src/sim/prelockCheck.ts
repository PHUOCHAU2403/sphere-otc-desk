/**
 * Pre-lock policy unit checks: timeout bounds + verification gate. No SDK.
 *   npx tsx src/sim/prelockCheck.ts
 */

import { timeoutWithinBounds, gateOnVerification } from '../domain/prelock.js';
import { PRELOCK_BOUNDS } from '../deskConfig.js';

let pass = true;
function check(label: string, cond: boolean): void {
  console.log(`   ${cond ? '✓' : '✗ FAIL'}  ${label}`);
  if (!cond) pass = false;
}

console.log('PRE-LOCK POLICY — bounds', JSON.stringify(PRELOCK_BOUNDS));

console.log('\n[A] timeout bounds');
check('30s rejected (< min)', !timeoutWithinBounds(30, PRELOCK_BOUNDS));
check('1800s accepted', timeoutWithinBounds(1800, PRELOCK_BOUNDS));
check('7200s rejected (> max)', !timeoutWithinBounds(7200, PRELOCK_BOUNDS));
check('min boundary inclusive', timeoutWithinBounds(PRELOCK_BOUNDS.minTimeoutSec, PRELOCK_BOUNDS));
check('max boundary inclusive', timeoutWithinBounds(PRELOCK_BOUNDS.maxTimeoutSec, PRELOCK_BOUNDS));

console.log('\n[B] verification gate');
const okV = { ok: true, reason: 'identity resolved' };
const badV = { ok: false, reason: 'does not resolve' };
check('require=true + verified → pass', gateOnVerification(okV, true).ok);
check('require=true + unverified → block', !gateOnVerification(badV, true).ok);
check('require=false + unverified → pass (warn mode)', gateOnVerification(badV, false).ok);
const blocked = gateOnVerification(badV, true);
check('block reason carries detail', !blocked.ok && blocked.reason.includes('does not resolve'));

console.log(`\n${pass ? '✓ ALL CHECKS PASSED' : '✗ SOME CHECKS FAILED'}\n`);
if (!pass) process.exit(1);
