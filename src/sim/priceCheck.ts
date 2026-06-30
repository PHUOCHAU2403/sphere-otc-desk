/**
 * Live smoke test for the price feeds — hits the real Crypto.com public API.
 *   npx tsx src/sim/priceCheck.ts
 */

import { CryptoComPriceFeed, BinancePriceFeed, decimalToScaled } from '../adapters/priceFeeds.js';
import { CompositePriceFeed, MedianPriceFeed, StaticPriceFeed } from '../domain/priceFeed.js';
import { PRICE_SCALE } from '../domain/quoteEngine.js';

const human = (s: bigint | null): string =>
  s === null ? 'null' : (Number(s) / Number(PRICE_SCALE)).toFixed(6);

async function main(): Promise<void> {
  // 1. decimalToScaled is exact (no float drift).
  const exact = decimalToScaled('62740.345');
  console.log('decimalToScaled("62740.345") =', exact, exact === 6274034500000n ? 'OK' : 'FAIL');

  // 2. Live exchange feed.
  const exchange = new CryptoComPriceFeed({
    instrumentMap: { 'BTC/USDU': 'BTC_USDT', 'ETH/USDU': 'ETH_USDT' },
  });
  console.log('BTC/USDU mid =', human(await exchange.midScaled('BTC', 'USDU')));
  console.log('ETH/USDU mid =', human(await exchange.midScaled('ETH', 'USDU')));
  console.log('XYZ/USDU mid =', human(await exchange.midScaled('XYZ', 'USDU')), '(unmapped → null)');

  // 3. Composite: manual override for an illiquid token + live for the rest.
  const feed = new CompositePriceFeed([new StaticPriceFeed({ 'UCT/USDU': 1.25 }), exchange]);
  console.log('composite UCT/USDU =', human(await feed.midScaled('UCT', 'USDU')), '(manual)');
  console.log('composite BTC/USDU =', human(await feed.midScaled('BTC', 'USDU')), '(exchange)');

  // 4. Cache hit on the second call should match.
  const a = await exchange.midScaled('BTC', 'USDU');
  const b = await exchange.midScaled('BTC', 'USDU');
  console.log('cache stable =', a === b ? 'OK' : 'FAIL');

  // 5. Second venue (Binance) + cross-venue median.
  const binance = new BinancePriceFeed({ instrumentMap: { 'BTC/USDU': 'BTCUSDT', 'ETH/USDU': 'ETHUSDT' } });
  console.log('binance BTC/USDU =', human(await binance.midScaled('BTC', 'USDU')));
  const med = new MedianPriceFeed([exchange, binance], 2);
  console.log('median(2 venues) BTC/USDU =', human(await med.midScaled('BTC', 'USDU')));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
