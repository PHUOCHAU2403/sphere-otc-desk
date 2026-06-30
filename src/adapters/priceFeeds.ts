/**
 * Network-backed PriceFeed implementations (live, so they live in adapters, not
 * the pure domain). Venues: Crypto.com Exchange and Binance public REST. Wrap
 * several in a MedianPriceFeed so no single venue can move the desk's price.
 */

import { PRICE_SCALE } from '../domain/quoteEngine.js';
import type { PriceFeed } from '../domain/priceFeed.js';

const CRYPTOCOM_BASE = 'https://api.crypto.com/exchange/v1';
const BINANCE_BASE = 'https://api.binance.com/api/v3';

interface CryptoComConfig {
  /**
   * Map domain `BASE/QUOTE` → exchange instrument name. The desk's quote coin
   * (e.g. USDU) is a USD stablecoin, so it maps to a USD-pegged exchange quote
   * such as USDT. Example: { 'BTC/USDU': 'BTC_USDT' }.
   */
  readonly instrumentMap: Readonly<Record<string, string>>;
  /** Cache lifetime per instrument (ms). Default 5s. */
  readonly cacheTtlMs?: number;
  /** Request timeout (ms). Default 4s. */
  readonly timeoutMs?: number;
  /** Never serve a cached price older than this on error (ms). Default 30s. */
  readonly maxStaleMs?: number;
  /** Reject a bid/ask mid that deviates from the last trade by more than this (bps). Default 500. */
  readonly maxDeviationBps?: number;
  readonly baseUrl?: string;
}

const BPS = 10_000n;

interface CacheEntry {
  scaled: bigint;
  at: number;
}

/** Live mid from Crypto.com Exchange: (best_bid + best_ask) / 2. */
export class CryptoComPriceFeed implements PriceFeed {
  private readonly map: Readonly<Record<string, string>>;
  private readonly ttl: number;
  private readonly timeout: number;
  private readonly maxStaleMs: number;
  private readonly maxDeviationBps: bigint;
  private readonly baseUrl: string;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(cfg: CryptoComConfig) {
    this.map = cfg.instrumentMap;
    this.ttl = cfg.cacheTtlMs ?? 5_000;
    this.timeout = cfg.timeoutMs ?? 4_000;
    this.maxStaleMs = cfg.maxStaleMs ?? 30_000;
    this.maxDeviationBps = BigInt(cfg.maxDeviationBps ?? 500);
    this.baseUrl = cfg.baseUrl ?? CRYPTOCOM_BASE;
  }

  /** Serve a cached value only if it's still within the staleness budget. */
  private staleOrNull(cached: CacheEntry | undefined): bigint | null {
    return cached && Date.now() - cached.at < this.maxStaleMs ? cached.scaled : null;
  }

  async midScaled(baseSymbol: string, quoteSymbol: string): Promise<bigint | null> {
    const instrument = this.map[`${baseSymbol}/${quoteSymbol}`];
    if (!instrument) return null; // not a pair this feed prices

    const cached = this.cache.get(instrument);
    if (cached && Date.now() - cached.at < this.ttl) return cached.scaled;

    try {
      const url = `${this.baseUrl}/public/get-tickers?instrument_name=${encodeURIComponent(instrument)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(this.timeout) });
      if (!res.ok) return this.staleOrNull(cached);
      const body = (await res.json()) as {
        code?: number;
        result?: { data?: Array<{ b?: string; k?: string; a?: string }> };
      };
      const t = body?.result?.data?.[0];
      if (body.code !== 0 || !t) return this.staleOrNull(cached);

      const bid = t.b ? decimalToScaled(t.b) : null;
      const ask = t.k ? decimalToScaled(t.k) : null;
      const last = t.a ? decimalToScaled(t.a) : null;

      // Prefer the bid/ask midpoint; fall back to last trade.
      const scaled = bid !== null && ask !== null ? (bid + ask) / 2n : last;
      if (scaled === null) return this.staleOrNull(cached);

      // Sanity band: a mid that has drifted far from the last trade signals a
      // crossed/stale book — refuse rather than quote off it.
      if (last !== null && last > 0n && deviates(scaled, last, this.maxDeviationBps)) {
        return this.staleOrNull(cached);
      }

      this.cache.set(instrument, { scaled, at: Date.now() });
      return scaled;
    } catch {
      return this.staleOrNull(cached); // network/timeout: stale-or-null, never throw
    }
  }
}

/** True if |a − ref| / ref exceeds maxBps. */
function deviates(a: bigint, ref: bigint, maxBps: bigint): boolean {
  const diff = a > ref ? a - ref : ref - a;
  return diff * BPS > maxBps * ref;
}

interface BinanceConfig {
  /** Map domain `BASE/QUOTE` → Binance symbol, e.g. { 'BTC/USDU': 'BTCUSDT' }. */
  readonly instrumentMap: Readonly<Record<string, string>>;
  readonly cacheTtlMs?: number;
  readonly timeoutMs?: number;
  readonly maxStaleMs?: number;
  readonly baseUrl?: string;
}

/** Live mid from Binance book ticker: (bidPrice + askPrice) / 2. */
export class BinancePriceFeed implements PriceFeed {
  private readonly map: Readonly<Record<string, string>>;
  private readonly ttl: number;
  private readonly timeout: number;
  private readonly maxStaleMs: number;
  private readonly baseUrl: string;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(cfg: BinanceConfig) {
    this.map = cfg.instrumentMap;
    this.ttl = cfg.cacheTtlMs ?? 5_000;
    this.timeout = cfg.timeoutMs ?? 4_000;
    this.maxStaleMs = cfg.maxStaleMs ?? 30_000;
    this.baseUrl = cfg.baseUrl ?? BINANCE_BASE;
  }

  private staleOrNull(cached: CacheEntry | undefined): bigint | null {
    return cached && Date.now() - cached.at < this.maxStaleMs ? cached.scaled : null;
  }

  async midScaled(baseSymbol: string, quoteSymbol: string): Promise<bigint | null> {
    const symbol = this.map[`${baseSymbol}/${quoteSymbol}`];
    if (!symbol) return null;

    const cached = this.cache.get(symbol);
    if (cached && Date.now() - cached.at < this.ttl) return cached.scaled;

    try {
      const url = `${this.baseUrl}/ticker/bookTicker?symbol=${encodeURIComponent(symbol)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(this.timeout) });
      if (!res.ok) return this.staleOrNull(cached);
      const t = (await res.json()) as { bidPrice?: string; askPrice?: string };
      const bid = t.bidPrice ? decimalToScaled(t.bidPrice) : null;
      const ask = t.askPrice ? decimalToScaled(t.askPrice) : null;
      if (bid === null || ask === null) return this.staleOrNull(cached);

      const scaled = (bid + ask) / 2n;
      this.cache.set(symbol, { scaled, at: Date.now() });
      return scaled;
    } catch {
      return this.staleOrNull(cached);
    }
  }
}

/**
 * Parse a decimal string into a PRICE_SCALE-scaled bigint with no float drift.
 * '62740.345' (scale 1e8) -> 6274034500000n. Returns null on malformed input.
 */
export function decimalToScaled(s: string, scale: bigint = PRICE_SCALE): bigint | null {
  const m = s.trim().match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  const sign = m[1] === '-' ? -1n : 1n;
  const intPart = m[2]!;
  const fracRaw = m[3] ?? '';
  const digits = scale.toString().length - 1; // 1e8 -> 8
  const frac = (fracRaw + '0'.repeat(digits)).slice(0, digits);
  return sign * (BigInt(intPart) * scale + BigInt(frac || '0'));
}
