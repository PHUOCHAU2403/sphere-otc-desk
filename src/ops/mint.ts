/**
 * Mint testnet2 fungible tokens directly into the TAKER wallet (no faucet needed
 * on v2 testnet — per Unicity dev). Used to fund the taker with USDU so it can
 * pay for a swap.
 *
 *   npm run mint -- USDU 100
 *   npm run mint -- UCT 10
 *
 * coinIds from the testnet2 token registry (unicitynetwork/unicity-ids).
 */

import '../adapters/wsShim.js';
import 'dotenv/config';
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders, createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

const env = (k: string, d = ''): string => process.env[k] ?? d;

const REGISTRY: Record<string, { coinId: string; decimals: number }> = {
  UCT: { coinId: 'f581d30f593e4b369d684a4563b5246f07b1d265f7178a2c0a82b81f39c24dc0', decimals: 18 },
  USDU: { coinId: 'e210f98956f564bfe67ee94fddd386b5157f660d1957169b391f962093a2da2a', decimals: 6 },
  EURU: { coinId: '9130b56f563b2d6ff8179174324404986a77a90394e1f3c2e3de6d149a8effbd', decimals: 6 },
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const asset = (args[0] ?? 'USDU').toUpperCase();
  const amountHuman = BigInt(args[1] ?? '100');
  const spec = REGISTRY[asset];
  if (!spec) {
    console.log('unknown asset', asset, '— known:', Object.keys(REGISTRY).join(', '));
    process.exit(1);
  }
  const amount = amountHuman * 10n ** BigInt(spec.decimals);

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
  console.log('wallet:', sphere.getNametag(), sphere.identity?.directAddress);

  console.log(`minting ${amountHuman} ${asset} (${amount} smallest units, coinId ${spec.coinId.slice(0, 12)}…)…`);
  await sphere.payments.mintFungibleToken(spec.coinId, amount);
  console.log('mint submitted ✓');

  await sphere.payments.receive().catch(() => undefined);
  console.log('\n=== BALANCE ===');
  for (const a of sphere.payments.getBalance()) {
    console.log('  ' + a.symbol + ' = ' + a.totalAmount + ' (decimals ' + a.decimals + ')');
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
