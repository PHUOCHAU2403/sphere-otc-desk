/**
 * Escrow agent — a third agent that atomically settles a swap between the desk
 * and a taker. The v2 testnet escrow isn't shipped yet (per Unicity dev), so we
 * run our own, exactly as suggested.
 *
 *   npm run escrow
 *
 * Protocol (own, over encrypted DMs + memo-tagged transfers):
 *   1. Desk DMs the escrow  { t:'escrow_open', swapId, partyA, partyB, aCoin,
 *      aAmount, bCoin, bAmount, timeoutSec }.
 *   2. Both parties send their leg to the escrow with memo = swapId.
 *   3. When BOTH legs arrive, the escrow pays them out crossed (aCoin→partyB,
 *      bCoin→partyA) and DMs { t:'escrow_settled', swapId } to both.
 *   4. On timeout with only one leg, it refunds that leg and DMs
 *      { t:'escrow_refunded', swapId }.
 *
 * Atomic from each party's view: both complete, or both keep their tokens.
 */

import '../adapters/wsShim.js';
import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders, createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

const env = (k: string, d = ''): string => process.env[k] ?? d;
const log = (m: string): void => console.log(`[escrow] ${new Date().toISOString().slice(11, 19)} ${m}`);

/** On-chain decimals per coin, for human-readable log amounts. */
const COIN_DECIMALS: Record<string, number> = { UCT: 18, USDU: 6, EURU: 6 };
/** Render a base-unit integer as a human amount, e.g. 6281250 USDU → "6.28125". */
const human = (amount: string, coin: string): string => {
  const d = COIN_DECIMALS[coin] ?? 0;
  if (d === 0) return amount;
  const s = amount.replace('-', '').padStart(d + 1, '0');
  const whole = s.slice(0, -d);
  const frac = s.slice(-d).replace(/0+$/, '');
  return (amount.startsWith('-') ? '-' : '') + whole + (frac ? '.' + frac : '');
};
/** "6.28125 USDU (6281250)" — pretty amount with the raw base-unit value. */
const amt = (amount: string, coin: string): string => `${human(amount, coin)} ${coin} (${amount})`;
const sid = (swapId: string): string => swapId.slice(0, 8) + '…';

interface Swap {
  partyA: string; // nametag depositing aCoin
  partyB: string; // nametag depositing bCoin
  aCoin: string;
  aAmount: string;
  bCoin: string;
  bAmount: string;
  timeoutSec: number;
  openedAt: number;
  aRecv: boolean;
  bRecv: boolean;
  done: boolean;
}

async function main(): Promise<void> {
  const network = env('SPHERE_NETWORK', 'testnet') as 'mainnet' | 'testnet' | 'dev';
  const apiKey = env('ORACLE_API_KEY');
  const base = createNodeProviders({
    network,
    dataDir: env('ESCROW_DATA_DIR', './escrow-data'),
    tokensDir: env('ESCROW_TOKENS_DIR', './escrow-tokens'),
    ...(apiKey ? { oracle: { apiKey } } : {}),
  });
  const providers = createWalletApiProviders(base, {
    baseUrl: env('WALLET_API_URL', 'https://wallet-api.unicity.network'),
    network: network === 'testnet' ? 'testnet2' : network,
    deviceId: env('ESCROW_DEVICE_ID', 'hau-escrow-node'),
  });
  const { sphere } = await Sphere.init({
    ...providers,
    network,
    ...(env('ESCROW_MNEMONIC') ? { mnemonic: env('ESCROW_MNEMONIC') } : { autoGenerate: true }),
    nametag: env('ESCROW_AGENT', 'hau-escrow').replace(/^@/, ''),
  });
  // A fresh escrow wallet has no nametag yet — register it and WAIT, so the desk
  // can resolve @hau-escrow before it tries to open a swap. (Passing `nametag` to
  // init is best-effort/async; on a brand-new wallet it may not be live yet.)
  const wantName = env('ESCROW_AGENT', 'hau-escrow').replace(/^@/, '');
  if (!sphere.getNametag()) {
    try {
      await sphere.registerNametag(wantName);
      log(`registered nametag @${wantName}`);
    } catch (e) {
      log(`registerNametag @${wantName} failed: ${String(e)} (may already be bound to this wallet)`);
    }
  }
  log(`identity @${sphere.getNametag() ?? '?'} ${sphere.identity?.directAddress?.slice(0, 40)}`);
  await sphere.payments.receive().catch(() => undefined);

  const swaps = new Map<string, Swap>();

  // Durable swap state so a mid-swap restart (or a transient wallet-api/DNS
  // outage during payout) never strands deposited legs — on boot we resume every
  // unsettled swap and the tick below retries it until it settles.
  const swapsFile = env('ESCROW_SWAPS_FILE', './escrow-data/swaps.json');
  const saveSwaps = (): void => {
    try {
      mkdirSync(dirname(swapsFile), { recursive: true });
      writeFileSync(swapsFile, JSON.stringify([...swaps.entries()]));
    } catch (e) {
      log(`persist error: ${String(e)}`);
    }
  };
  try {
    if (existsSync(swapsFile)) {
      const arr = JSON.parse(readFileSync(swapsFile, 'utf8')) as Array<[string, Swap]>;
      for (const [k, v] of arr) if (!v.done) swaps.set(k, v);
      if (swaps.size) log(`resumed ${swaps.size} unsettled swap(s) from disk`);
    }
  } catch (e) {
    log(`resume error: ${String(e)}`);
  }

  const balanceLine = (): string =>
    sphere.payments.getBalance().map((b) => `${human(b.totalAmount, b.symbol)} ${b.symbol}`).join(', ') || '(empty)';
  log(`balance: ${balanceLine()}`);

  // Reconcile leg state against the chain (ground truth). Live `transfer:incoming`
  // events don't replay across a restart, so a swap can look like it received
  // nothing even though the tokens are already in our wallet. Derive aRecv/bRecv
  // from the actual balance, allocating greedily (oldest swap first) so multiple
  // concurrent swaps sharing a coin never double-count the same tokens.
  const reconcileFromBalance = (): void => {
    if (swaps.size === 0) return;
    const remaining = new Map<string, bigint>();
    for (const b of sphere.payments.getBalance()) remaining.set(b.symbol, BigInt(b.totalAmount));
    const take = (coin: string, need: bigint): boolean => {
      const have = remaining.get(coin) ?? 0n;
      if (have < need) return false;
      remaining.set(coin, have - need);
      return true;
    };
    let changed = false;
    const pending = [...swaps.entries()].filter(([, s]) => !s.done).sort((a, b) => a[1].openedAt - b[1].openedAt);
    for (const [swapId, s] of pending) {
      if (!s.aRecv && take(s.aCoin, BigInt(s.aAmount))) { s.aRecv = true; changed = true; }
      if (!s.bRecv && take(s.bCoin, BigInt(s.bAmount))) { s.bRecv = true; changed = true; }
      if (changed && s.aRecv && s.bRecv) log(`reconciled ${sid(swapId)} from balance — both legs present, settling`);
    }
    if (changed) saveSwaps();
  };
  reconcileFromBalance();

  const trySettle = async (swapId: string): Promise<void> => {
    const s = swaps.get(swapId);
    if (!s || s.done || !s.aRecv || !s.bRecv) return;
    s.done = true;
    log(`both legs in for ${sid(swapId)} — paying out…`);
    try {
      await sphere.payments.send({ coinId: s.aCoin, amount: s.aAmount, recipient: s.partyB, memo: swapId });
      await sphere.payments.send({ coinId: s.bCoin, amount: s.bAmount, recipient: s.partyA, memo: swapId });
      const note = JSON.stringify({ t: 'escrow_settled', swapId });
      await sphere.communications.sendDM(s.partyA, note);
      await sphere.communications.sendDM(s.partyB, note);
      saveSwaps();
      log(`SETTLED ${sid(swapId)} ✓  ${amt(s.aAmount, s.aCoin)}→${s.partyB}, ${amt(s.bAmount, s.bCoin)}→${s.partyA}`);
    } catch (e) {
      s.done = false;
      log(`payout error for ${sid(swapId)}: ${String(e)} (will retry on next tick)`);
    }
  };

  sphere.communications.onDirectMessage((m) => {
    let msg: { t?: string; swapId?: string; [k: string]: unknown };
    try {
      msg = JSON.parse(m.content);
    } catch {
      return;
    }
    if (msg.t === 'escrow_open' && typeof msg.swapId === 'string') {
      // Idempotent: a re-delivered escrow_open (mailbox backlog after a restart)
      // must NOT wipe leg state we've already recorded/reconciled.
      if (swaps.has(msg.swapId)) {
        log(`escrow_open ${sid(msg.swapId)} already known — ignoring re-delivery`);
        return;
      }
      const aCoin = String(msg['aCoin']);
      const bCoin = String(msg['bCoin']);
      const aAmount = String(msg['aAmount']);
      const bAmount = String(msg['bAmount']);
      swaps.set(msg.swapId, {
        partyA: String(msg['partyA']),
        partyB: String(msg['partyB']),
        aCoin,
        aAmount,
        bCoin,
        bAmount,
        timeoutSec: Number(msg['timeoutSec'] ?? 3600),
        openedAt: Date.now(),
        aRecv: false,
        bRecv: false,
        done: false,
      });
      saveSwaps();
      log(`opened ${sid(msg.swapId)}: ${msg['partyA']} gives ${amt(aAmount, aCoin)} ⇄ ${msg['partyB']} gives ${amt(bAmount, bCoin)}`);
    }
  });

  sphere.on('transfer:incoming', (e) => {
    const t = e as { memo?: string; senderNametag?: string; tokens?: Array<{ symbol: string; amount: string }> };
    const swapId = t.memo;
    if (!swapId) return;
    const s = swaps.get(swapId);
    if (!s || s.done) return;
    for (const tok of t.tokens ?? []) {
      if (tok.symbol === s.aCoin) s.aRecv = true;
      if (tok.symbol === s.bCoin) s.bRecv = true;
    }
    saveSwaps();
    log(`deposit for ${sid(swapId)} from ${t.senderNametag ?? '?'} — legs: A=${s.aRecv} B=${s.bRecv}`);
    void sphere.payments.receive().catch(() => undefined).then(() => trySettle(swapId));
  });

  // Periodic tick: (a) retry a payout that failed transiently (e.g. wallet-api
  // DNS blip) once both legs are in; (b) refund a lone leg after its timeout.
  setInterval(() => {
    // Re-derive leg state from the wallet each tick — self-heals a swap whose
    // deposit event was missed (restart / re-delivered escrow_open).
    reconcileFromBalance();
    const now = Date.now();
    for (const [swapId, s] of swaps) {
      if (s.done) continue;
      // (a) both legs present but not yet paid out — retry until it sticks.
      if (s.aRecv && s.bRecv) {
        void trySettle(swapId);
        continue;
      }
      if (now < s.openedAt + s.timeoutSec * 1000) continue;
      if (s.aRecv !== s.bRecv) {
        s.done = true;
        const [coin, amount, to] = s.aRecv ? [s.aCoin, s.aAmount, s.partyA] : [s.bCoin, s.bAmount, s.partyB];
        log(`timeout ${sid(swapId)} — refunding ${amt(amount, coin)} → ${to}`);
        void sphere.payments
          .send({ coinId: coin, amount, recipient: to, memo: swapId })
          .then(() => sphere.communications.sendDM(to, JSON.stringify({ t: 'escrow_refunded', swapId })))
          .catch((err) => log(`refund error ${sid(swapId)}: ${String(err)}`));
        saveSwaps();
      } else if (!s.aRecv && !s.bRecv) {
        s.done = true; // nobody deposited — just drop it
        saveSwaps();
      }
    }
  }, 15_000);

  log('escrow running. Waiting for escrow_open + deposits…');
  process.on('SIGINT', () => void sphere.destroy().then(() => process.exit(0)));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
