/**
 * Live OTC desk agent. Boots the Sphere SDK on Node, syncs inventory from
 * on-chain balances, advertises the desk on the market, and runs headless.
 *
 * Requires a real @unicitylabs/sphere-sdk install + testnet access. Configure
 * via .env (see .env.example). For a no-network walkthrough, run `npm run sim`.
 */

import './adapters/wsShim.js'; // MUST be first — swaps in the `ws` WebSocket before the SDK loads
import 'dotenv/config'; // load .env into process.env
import { access } from 'node:fs/promises';
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders, createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';
import { buildDesk, UCT, USDU } from './deskConfig.js';
import { SphereOtcDesk } from './adapters/sphereDesk.js';
import { CompositePriceFeed, MedianPriceFeed, StaticPriceFeed } from './domain/priceFeed.js';
import { KillSwitch } from './domain/killSwitch.js';
import { PnlTracker } from './domain/pnl.js';
import { CryptoComPriceFeed, BinancePriceFeed } from './adapters/priceFeeds.js';
import { FileStore } from './adapters/fileStore.js';
import { FileAuditLog } from './adapters/fileAuditLog.js';
import { Persister } from './adapters/persister.js';
import { SphereCounterpartyVerifier } from './adapters/counterpartyVerifier.js';
import type { PriceFeed } from './domain/priceFeed.js';

const env = (k: string, d = ''): string => process.env[k] ?? d;

/**
 * Manual control: presence of the HALT file pauses the desk (no new quotes,
 * accepts, or swaps); removing it resumes. Polled so an operator can toggle it
 * with a plain `touch`/`rm` from anywhere.
 */
function watchControlFile(path: string, ks: KillSwitch, log: (l: string) => void): () => void {
  let halted = false;
  const tick = async (): Promise<void> => {
    const present = await access(path).then(() => true, () => false);
    if (present && !halted) {
      halted = true;
      ks.halt(`manual: ${path} present`);
      log(`*** HALTED via control file ${path} ***`);
    } else if (!present && halted) {
      halted = false;
      ks.resume();
      log('*** RESUMED — control file removed ***');
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), 3_000);
  return () => clearInterval(timer);
}

/**
 * Live reference price: a manual override for illiquid OTC tokens (UCT has no
 * CEX market) layered over live exchange feeds for liquid pairs. Exchange feeds
 * are wrapped in a MedianPriceFeed so no single venue can move the desk's price;
 * add more venues to the array to harden further. USDU ≈ USD → maps to USDT.
 */
function buildLivePriceFeed(): PriceFeed {
  const manual: Record<string, number> = {};
  const uctMid = Number(env('UCT_USDU_MID', '0'));
  if (uctMid > 0) manual['UCT/USDU'] = uctMid;

  const cryptocom = new CryptoComPriceFeed({
    instrumentMap: { 'BTC/USDU': 'BTC_USDT', 'ETH/USDU': 'ETH_USDT' },
    cacheTtlMs: 5_000,
    maxStaleMs: 30_000,
    maxDeviationBps: 500,
  });
  const binance = new BinancePriceFeed({
    instrumentMap: { 'BTC/USDU': 'BTCUSDT', 'ETH/USDU': 'ETHUSDT' },
    cacheTtlMs: 5_000,
    maxStaleMs: 30_000,
  });

  // Median across venues so no single feed can move the desk's price. Raise
  // MIN_PRICE_SOURCES to 2 to require a quorum (refuses to quote if a venue is
  // down — safer but less available); default 1 keeps the desk quoting on one.
  const minSources = Number(env('MIN_PRICE_SOURCES', '1'));
  const exchanges = new MedianPriceFeed([cryptocom, binance], minSources);

  return new CompositePriceFeed([new StaticPriceFeed(manual), exchanges]);
}

async function main(): Promise<void> {
  const network = env('SPHERE_NETWORK', 'testnet') as 'mainnet' | 'testnet' | 'dev';
  const escrow = env('ESCROW_ADDRESS', '@escrow-testnet');

  const apiKey = env('ORACLE_API_KEY');
  // Extra Nostr relays — must include the relay the counterparty/web wallet
  // publishes transfers to, or incoming transfers never arrive (per Unicity dev:
  // "you need same relay"). Comma-separated.
  const extraRelays = env('NOSTR_RELAYS').split(',').map((s) => s.trim()).filter(Boolean);
  if (extraRelays.length) console.log('extra relays:', extraRelays.join(', '));
  // Layer 1 — base: storage + transport (Nostr = messaging/nametags only) + oracle.
  const base = createNodeProviders({
    network,
    dataDir: env('DATA_DIR', './wallet-data'),
    tokensDir: env('TOKENS_DIR', './tokens'),
    ...(apiKey ? { oracle: { apiKey } } : {}),
    ...(extraRelays.length ? { transport: { additionalRelays: extraRelays } } : {}),
  });
  // Layer 2 — wallet-api rails: mailbox `delivery` + REST client. THIS is what
  // lets the wallet send/RECEIVE v2 token transfers (Nostr does not carry tokens).
  const providers = createWalletApiProviders(base, {
    baseUrl: env('WALLET_API_URL', 'https://wallet-api.unicity.network'),
    network: network === 'testnet' ? 'testnet2' : network,
    deviceId: env('DEVICE_ID', env('DESK_NAMETAG', 'otc-desk') + '-node'),
  });

  const mnemonic = env('WALLET_MNEMONIC');
  const { sphere, generatedMnemonic } = await Sphere.init({
    ...providers,
    network, // required by Sphere.init to configure the token registry
    ...(mnemonic ? { mnemonic } : { autoGenerate: true }),
    nametag: env('DESK_NAMETAG', 'otc-desk'),
    accounting: true, // required by the swap module
    swap: { defaultEscrowAddress: escrow },
    market: true, // advertise the desk on the intent bulletin board
  });

  if (generatedMnemonic) {
    console.log('\n*** SAVE THIS MNEMONIC (shown once) ***\n' + generatedMnemonic + '\n');
  }
  console.log('desk identity:', sphere.identity?.nametag ?? sphere.identity?.directAddress);

  // Pull any pending incoming transfers — L3 bearer tokens must be actively
  // received before they show up in getBalance().
  try {
    const recv = await sphere.payments.receive();
    console.log('received incoming transfers:', recv.transfers.length);
  } catch (e) {
    console.log('receive error (continuing):', String(e));
  }

  // Load any persisted state (reservations, limit counters, in-flight deals).
  const store = new FileStore(env('STATE_FILE', './wallet-data/desk-state.json'));
  const snapshot = await store.load();

  // Safety: shared kill-switch (manual + auto breaker) and hash-chained audit.
  // A latched halt survives restarts so we never boot back into a hot state.
  const breakerCfg = { maxConsecutiveFailures: Number(env('MAX_CONSEC_FAILURES', '3')) };
  const killSwitch =
    snapshot?.killSwitch ? KillSwitch.restore(breakerCfg, snapshot.killSwitch) : new KillSwitch(breakerCfg);
  if (killSwitch.isHalted()) console.log(`booting HALTED: ${killSwitch.reason()}`);
  const audit = new FileAuditLog(env('AUDIT_FILE', './wallet-data/audit.jsonl'));

  // P&L breaker: halt on daily mark-to-market loss. Baseline is set fresh from
  // current equity on each boot (NOT restored) — a persisted baseline taken when
  // inventory/decimals were in a different state produces phantom P&L swings.
  const maxDailyLoss = BigInt(env('MAX_DAILY_LOSS_USDU', '5000')) * 1_000000n; // USDU 6dp
  const pnl = new PnlTracker(maxDailyLoss);

  const priceFeed = buildLivePriceFeed();

  // Read the chain once: derive REAL per-symbol decimals (UCT is 18 on testnet2,
  // not the 8 in our defaults) + the current balances. Decimals must feed the
  // pair config before buildDesk, or all quote/P&L math is off by 10^(real−8).
  const symbolToCoin: Record<string, string> = { UCT: UCT.coinId, USDU: USDU.coinId };
  // Live decimal fallbacks (testnet2): used if getBalance() is empty — e.g. when
  // wallet-api is briefly unreachable — so maxDealBase/quote math stay correct and
  // a normal RFQ isn't wrongly rejected as SIZE_TOO_LARGE.
  const coinDecimals: Record<string, number> = { UCT: 18, USDU: 6 };
  const chain = new Map<string, bigint>();
  const assets = sphere.payments.getBalance();
  for (const asset of assets) {
    coinDecimals[asset.symbol] = asset.decimals;
    const coin = symbolToCoin[asset.symbol];
    if (coin) chain.set(coin, BigInt(asset.totalAmount));
  }
  if (assets.length === 0)
    console.log('WARN: getBalance() empty — wallet-api may be unreachable; inventory fills via true-up when it recovers');
  console.log('chain decimals:', coinDecimals);

  // Build domain core with the real decimals. With a snapshot, the ledger is
  // restored from disk; otherwise free balances are set from the chain below.
  const desk = snapshot
    ? buildDesk({ priceFeed, snapshot, killSwitch, pnl, seedDemo: false, coinDecimals })
    : buildDesk({ priceFeed, killSwitch, pnl, seedDemo: false, coinDecimals });

  // Reconcile against the chain on boot: chain is authoritative for balances.
  // Fresh wallet → set directly; restored snapshot → true-up so undeposited
  // reservations are respected.
  if (snapshot) {
    console.log(`restored snapshot from ${new Date(snapshot.updatedAt).toISOString()}`);
    desk.inventory.trueUp(chain);
  } else {
    for (const [coin, amt] of chain) desk.inventory.setBalance(coin, amt);
  }
  const bals = desk.inventory.snapshot().balances;
  const human = Object.entries(bals)
    .map(([coin, raw]) => {
      const dec = coinDecimals[coin] ?? (coin === UCT.coinId ? UCT.decimals : USDU.decimals);
      return `${coin}=${Number(BigInt(raw)) / 10 ** dec}`;
    })
    .join('  ');
  console.log('inventory (human):', human || '(empty)');

  const persister = new Persister({
    inventory: desk.inventory,
    negotiation: desk.negotiation,
    killSwitch,
    pnl,
    store,
  });

  const live = new SphereOtcDesk({
    sphere,
    negotiation: desk.negotiation,
    inventory: desk.inventory,
    persister,
    killSwitch,
    pnl,
    pairs: desk.pairs,
    priceFeed,
    audit,
    escrowAddress: escrow,
    escrowAgent: '@' + env('ESCROW_AGENT', 'hau-escrow').replace(/^@/, ''),
    symbolToCoin,
    verifier: new SphereCounterpartyVerifier(sphere),
    requireVerification: env('REQUIRE_VERIFICATION', 'true') !== 'false',
  });
  const stop = live.start(); // subscribe to DMs + transfers FIRST, before anything that can fail

  // Advertise on the market — non-fatal: a market-api outage must not stop the
  // desk from listening for and receiving transfers.
  try {
    await sphere.market!.postIntent({
      description: 'OTC desk — two-way market in UCT/USDU. DM an RFQ to trade.',
      intentType: 'sell',
      category: 'crypto-otc',
      price: 0,
      currency: 'USDU',
    });
    console.log('posted market intent');
  } catch (e) {
    console.log('market postIntent failed (non-fatal):', String(e));
  }

  const stopControl = watchControlFile(env('CONTROL_FILE', './wallet-data/HALT'), killSwitch, console.log);
  const stopTrueUp = live.startTrueUp(Number(env('TRUEUP_INTERVAL_MS', '60000')));
  const stopDailyReset = live.startDailyReset();
  const stopPnlGuard = live.startPnlGuard(Number(env('PNL_INTERVAL_MS', '30000')));

  await audit.append('boot', { identity: sphere.identity?.nametag ?? sphere.identity?.directAddress ?? null });

  // Bring restored in-flight deals back in sync with the escrow before serving.
  await live.reconcile();
  console.log('OTC desk running. Listening for RFQs…');

  const shutdown = async (): Promise<void> => {
    stop();
    stopControl();
    stopTrueUp();
    stopDailyReset();
    stopPnlGuard();
    await audit.append('shutdown', {});
    await persister.flush(); // never lose the latest state on exit
    await audit.close();
    await sphere.destroy();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
