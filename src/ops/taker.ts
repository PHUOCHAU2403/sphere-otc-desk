/**
 * Taker agent — a second wallet that RFQs the desk, prints the quote, and
 * (with --accept) completes the atomic swap. Demonstrates a full live
 * machine-to-machine OTC deal on testnet.
 *
 *   npm run taker -- buy 5             # Chặng A: RFQ → quote only
 *   npm run taker -- buy 5 --accept    # Chặng B: RFQ → quote → accept → swap
 *
 * Uses its OWN wallet (TAKER_* env). Fund it first: npm run mint -- USDU 100.
 */

import '../adapters/wsShim.js';
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders, createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

const env = (k: string, d = ''): string => process.env[k] ?? d;
const UCT_DECIMALS = 18;
const USDU_DECIMALS = 6;
const PRICE_SCALE = 1e8;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const accept = argv.includes('--accept');
  const args = argv.filter((a) => !a.startsWith('--'));
  const side = (args[0] === 'sell' ? 'sell' : 'buy') as 'buy' | 'sell';
  const amountUct = Number(args[1] ?? '10');
  const deskTag = '@' + env('DESK_NAMETAG', 'hau-otc-desk').replace(/^@/, '');

  const network = env('SPHERE_NETWORK', 'testnet') as 'mainnet' | 'testnet' | 'dev';
  const apiKey = env('ORACLE_API_KEY');
  const base = createNodeProviders({
    network,
    dataDir: env('TAKER_DATA_DIR', './taker-data'),
    tokensDir: env('TAKER_TOKENS_DIR', './taker-tokens'),
    ...(apiKey ? { oracle: { apiKey } } : {}),
  });
  const providers = createWalletApiProviders(base, {
    baseUrl: env('WALLET_API_URL', 'https://wallet-api.unicity.network'),
    network: network === 'testnet' ? 'testnet2' : network,
    deviceId: env('TAKER_DEVICE_ID', 'hau-taker-node'),
  });
  const mnemonic = env('TAKER_MNEMONIC');
  const { sphere } = await Sphere.init({
    ...providers,
    network,
    ...(mnemonic ? { mnemonic } : { autoGenerate: true }),
    nametag: env('TAKER_NAMETAG', 'hau-taker'),
    accounting: true, // required for token engine (send/receive/mint)
  });
  console.log('taker identity:', sphere.getNametag(), sphere.identity?.directAddress);
  await sphere.payments.receive().catch(() => undefined);

  const peer = await sphere.resolve(deskTag).catch(() => null);
  console.log('desk resolves:', peer?.directAddress ?? 'NULL');
  if (!peer) {
    console.log('cannot resolve desk — is it running and the nametag correct?');
    process.exit(1);
  }

  const rfqId = randomUUID().slice(0, 8);
  const baseAmount = (BigInt(Math.round(amountUct)) * 10n ** BigInt(UCT_DECIMALS)).toString();
  let finish: () => void = () => undefined;
  const done = new Promise<void>((resolve) => (finish = resolve));

  // --- DM handler: quote, then escrow-agent settlement (Chặng B) ---
  sphere.communications.onDirectMessage((m) => {
    let msg: { t?: string; rfqId?: string; [k: string]: unknown };
    try {
      msg = JSON.parse(m.content);
    } catch {
      return;
    }
    // Escrow callbacks carry no rfqId — handle before the rfq filter.
    if (msg.t === 'escrow_settled') {
      console.log('\n=== SWAP SETTLED ✓ (escrow paid out) ===');
      finish();
      return;
    }
    if (msg.t === 'escrow_refunded') {
      console.log('\n=== SWAP REFUNDED (counterparty did not deposit in time) ===');
      finish();
      return;
    }
    if (msg.rfqId !== rfqId) return;
    if (msg.t === 'quote') {
      const price = Number(msg['priceScaled']) / PRICE_SCALE;
      const qty = Number(BigInt(String(msg['baseAmount']))) / 10 ** UCT_DECIMALS;
      const cost = Number(BigInt(String(msg['quoteAmount']))) / 10 ** USDU_DECIMALS;
      console.log('\n=== QUOTE FROM DESK ===');
      console.log(`  ${side} ${qty} UCT @ ${price} = ${cost} USDU`);
      if (accept) {
        console.log('  → accepting; the desk will open an escrow-mediated swap…');
        void sphere.communications.sendDM(deskTag, JSON.stringify({ t: 'accept', rfqId }));
      } else {
        console.log('\n(Chặng A — quote only. Add --accept for the swap.)');
        finish();
      }
    } else if (msg.t === 'reject') {
      console.log('\n=== DESK REJECTED ===  reason:', msg['reason']);
      finish();
    } else if (msg.t === 'settle') {
      // Desk opened the swap via the escrow — pay our leg to the escrow.
      const swapId = String(msg['swapId']);
      const escrowTag = String(msg['escrow']);
      const payCoin = String(msg['payCoin']);
      const payAmount = String(msg['payAmount']);
      console.log(`⇄ paying ${payCoin} ${payAmount} to escrow ${escrowTag} (memo ${swapId.slice(0, 8)}…)`);
      void sphere.payments
        .send({ coinId: payCoin, amount: payAmount, recipient: escrowTag, memo: swapId })
        .then(() => console.log('  taker leg deposited ✓ — waiting for escrow to settle…'))
        .catch((err) => {
          console.log('  deposit error:', String(err));
          finish();
        });
    }
  });

  await sphere.communications.sendDM(
    deskTag,
    JSON.stringify({ t: 'rfq', rfqId, side, base: 'UCT', baseAmount }),
  );
  console.log(`sent RFQ ${rfqId}: ${side} ${amountUct} UCT → ${deskTag}${accept ? ' (will swap)' : ''}`);
  console.log(accept ? 'waiting for quote + swap (120s)…' : 'waiting for quote (30s)…');

  await Promise.race([done, new Promise((r) => setTimeout(r, accept ? 120_000 : 30_000))]);

  console.log('\n=== TAKER BALANCE ===');
  await sphere.payments.receive().catch(() => undefined);
  for (const a of sphere.payments.getBalance()) {
    console.log('  ' + a.symbol + ' = ' + a.totalAmount + ' (decimals ' + a.decimals + ')');
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
