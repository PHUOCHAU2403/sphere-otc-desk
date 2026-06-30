/**
 * Wallet diagnostic — load the desk wallet and dump what it actually sees:
 * identity, nametag resolution, pending receives, balances, history.
 *   npm run wallet
 */

import '../adapters/wsShim.js'; // ws WebSocket before SDK loads
import 'dotenv/config';
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders, createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

const env = (k: string, d = ''): string => process.env[k] ?? d;
const line = (m: string): void => console.log(m);

async function main(): Promise<void> {
  const network = env('SPHERE_NETWORK', 'testnet') as 'mainnet' | 'testnet' | 'dev';
  const apiKey = env('ORACLE_API_KEY');
  const extraRelays = env('NOSTR_RELAYS').split(',').map((s) => s.trim()).filter(Boolean);
  const base = createNodeProviders({
    network,
    dataDir: env('DATA_DIR', './wallet-data'),
    tokensDir: env('TOKENS_DIR', './tokens'),
    ...(apiKey ? { oracle: { apiKey } } : {}),
    ...(extraRelays.length ? { transport: { additionalRelays: extraRelays } } : {}),
  });
  const providers = createWalletApiProviders(base, {
    baseUrl: env('WALLET_API_URL', 'https://wallet-api.unicity.network'),
    network: network === 'testnet' ? 'testnet2' : network,
    deviceId: env('DEVICE_ID', env('DESK_NAMETAG', 'otc-desk') + '-node'),
  });
  const mnemonic = env('WALLET_MNEMONIC');
  const { sphere } = await Sphere.init({
    ...providers,
    network,
    ...(mnemonic ? { mnemonic } : { autoGenerate: true }),
    nametag: env('DESK_NAMETAG', 'otc-desk'),
  });

  line('\n=== IDENTITY ===');
  line('network  : ' + network);
  line('nametag  : ' + (sphere.getNametag() ?? '(none)'));
  line('direct   : ' + (sphere.identity?.directAddress ?? '(none)'));
  line('chainKey : ' + (sphere.identity?.chainPubkey ?? '(none)'));

  const nt = sphere.getNametag();
  if (nt) {
    const peer = await sphere.resolve(nt).catch(() => null);
    line('\n=== NAMETAG RESOLVES TO ===');
    line('resolve(' + nt + ') → ' + (peer?.directAddress ?? 'NULL'));
    line('matches own identity? ' + (peer?.directAddress === sphere.identity?.directAddress ? 'YES ✓' : 'NO ✗'));
  }

  line('\n=== RECEIVE (pull pending transfers) ===');
  const recv = await sphere.payments.receive().catch((e) => {
    line('receive error: ' + String(e));
    return null;
  });
  if (recv) {
    line('transfers received: ' + recv.transfers.length);
    for (const t of recv.transfers) line('  ' + JSON.stringify(t).slice(0, 240));
  }

  line('\n=== BALANCE ===');
  const bal = sphere.payments.getBalance();
  line('assets: ' + bal.length);
  for (const a of bal) {
    line('  ' + a.symbol + ' = ' + a.totalAmount + '  (decimals ' + a.decimals + ', coinId ' + a.coinId + ')');
  }

  line('\n=== HISTORY (last 6) ===');
  try {
    const h = sphere.payments.getHistory();
    line('entries: ' + h.length);
    for (const x of h.slice(-6)) line('  ' + JSON.stringify(x).slice(0, 200));
  } catch (e) {
    line('history unavailable: ' + String(e));
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
