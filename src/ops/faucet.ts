/**
 * Faucet requester — DMs the Unicity testnet faucet agent to fund the TAKER
 * wallet (so it can pay for a swap). The faucet is DM-driven (ACP FAUCET_REQUEST).
 *
 *   npm run faucet -- @faucet-nametag USDU 100
 *   npm run faucet -- @faucet-nametag UCT 50
 *
 * Get the faucet's nametag from the Unicity Discord (#dev). Uses the TAKER wallet
 * (TAKER_* env) and requests delivery to itself.
 */

import '../adapters/wsShim.js';
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders, createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

const env = (k: string, d = ''): string => process.env[k] ?? d;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const faucetTag = args[0];
  const asset = args[1] ?? 'USDU';
  const amount = args[2] ?? '100';
  if (!faucetTag) {
    console.log('usage: npm run faucet -- @faucet-nametag [asset] [amount]');
    process.exit(1);
  }

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
  });

  const recipient = '@' + (sphere.getNametag() ?? '').replace(/^@/, '');
  console.log('requesting', amount, asset, '→', recipient, 'from', faucetTag);

  const commandId = randomUUID();
  const replied = new Promise<void>((resolve) => {
    sphere.communications.onDirectMessage((m) => {
      try {
        const msg = JSON.parse(m.content) as { command_id?: string; ok?: boolean; result?: unknown; error?: unknown };
        if (msg.command_id !== commandId) return;
        console.log('\n=== FAUCET REPLY ===');
        console.log(JSON.stringify(msg, null, 2).slice(0, 800));
        resolve();
      } catch {
        /* ignore non-JSON */
      }
    });
  });

  await sphere.communications.sendDM(
    faucetTag,
    JSON.stringify({
      command_id: commandId,
      name: 'FAUCET_REQUEST',
      params: { recipient, items: [{ asset, amount }] },
    }),
  );
  console.log('FAUCET_REQUEST sent; waiting for delivery (45s)…');

  await Promise.race([replied, new Promise((r) => setTimeout(r, 45_000))]);

  // Pull the minted tokens into the wallet and show balance.
  const recv = await sphere.payments.receive().catch(() => ({ transfers: [] }));
  console.log('received transfers:', recv.transfers.length);
  for (const a of sphere.payments.getBalance()) {
    console.log('  ' + a.symbol + ' = ' + a.totalAmount + ' (decimals ' + a.decimals + ')');
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
