/**
 * Wires the domain core into a ready-to-use desk: pairs, risk limits, engine,
 * negotiation. Shared by both the simulation (src/sim) and the live agent
 * (src/index.ts) so they exercise identical logic.
 */

import { QuoteEngine } from './domain/quoteEngine.js';
import { NegotiationEngine } from './domain/negotiation.js';
import { Inventory } from './domain/inventory.js';
import type { RiskLimits } from './domain/inventory.js';
import { KillSwitch } from './domain/killSwitch.js';
import { PnlTracker } from './domain/pnl.js';
import { StaticPriceFeed } from './domain/priceFeed.js';
import type { PriceFeed } from './domain/priceFeed.js';
import type { PairSpec } from './domain/types.js';
import type { DeskSnapshot } from './domain/persistence.js';

/** Risk limits — fixed config, must be identical across restarts. */
export const RISK_LIMITS: RiskLimits = {
  perCounterpartyDaily: 100_000_000000n, // 100k USDU/day per counterparty (6 dp)
  maxOpenExposure: 500_000_000000n, // 500k USDU total open
};

/** Halt the desk if the day's mark-to-market loss reaches this (USDU, 6 dp). */
export const DEFAULT_MAX_DAILY_LOSS = 5_000_000000n; // 5,000 USDU

/** Acceptable swap-timeout window: short enough to avoid liquidity lock, long
 * enough to lock safely before it (late-lock protection). */
export const PRELOCK_BOUNDS = { minTimeoutSec: 120, maxTimeoutSec: 3600 } as const;

// Coin specs. `decimals` here are sim/fallback defaults; live mode overrides them
// with the real on-chain decimals from getBalance() (UCT is 18 on testnet2, not
// 8). coinId 'UCT'/'USDU' are symbols the SDK auto-resolves to hex coinIds.
export const UCT = { coinId: 'UCT', symbol: 'UCT', decimals: 8 } as const;
export const USDU = { coinId: 'USDU', symbol: 'USDU', decimals: 6 } as const;

/**
 * Build the pair set. `decimalsOverride` (symbol → decimals) lets live mode pass
 * the real on-chain decimals; sim omits it and uses the constants above.
 * maxDealBase is derived from the base decimals so it's correct either way.
 */
export function buildPairs(decimalsOverride: Readonly<Record<string, number>> = {}): Map<string, PairSpec> {
  const base = { ...UCT, decimals: decimalsOverride[UCT.symbol] ?? UCT.decimals };
  const quote = { ...USDU, decimals: decimalsOverride[USDU.symbol] ?? USDU.decimals };
  const pairs = new Map<string, PairSpec>();
  pairs.set('UCT', {
    base,
    quote,
    spreadBps: 50, // 0.50% quoted half-spread
    floorBps: 10, // will concede down to 0.10% (reservation price)
    maxDealBase: 1_000n * 10n ** BigInt(base.decimals), // 1,000 UCT in real units
    quoteTtlMs: 30_000,
  });
  return pairs;
}

export interface DeskParts {
  readonly pairs: Map<string, PairSpec>;
  readonly inventory: Inventory;
  readonly priceFeed: PriceFeed;
  readonly engine: QuoteEngine;
  readonly negotiation: NegotiationEngine;
  readonly killSwitch: KillSwitch;
  readonly pnl: PnlTracker;
}

export interface BuildDeskOptions {
  readonly now?: () => number;
  /** Reference price source; defaults to a fixed StaticPriceFeed (sim). */
  readonly priceFeed?: PriceFeed;
  /** Restore reserved legs, limits counters, and in-flight sessions from disk. */
  readonly snapshot?: DeskSnapshot;
  /** Override the kill-switch (e.g. share one across components). */
  readonly killSwitch?: KillSwitch;
  /** Override the P&L tracker (e.g. restored from disk with an env loss limit). */
  readonly pnl?: PnlTracker;
  /** Seed demo balances when there's no snapshot. Default true (sim); set false
   *  for live so inventory starts empty and reflects only the real chain balance. */
  readonly seedDemo?: boolean;
  /** Real on-chain decimals per symbol (live) — overrides the CoinSpec defaults. */
  readonly coinDecimals?: Readonly<Record<string, number>>;
}

/**
 * Build the desk. With no snapshot it seeds demo inventory; with a snapshot it
 * rehydrates the ledger + in-flight sessions so a restart keeps open deals.
 */
export function buildDesk(opts: BuildDeskOptions = {}): DeskParts {
  const now = opts.now ?? Date.now;
  const priceFeed = opts.priceFeed ?? new StaticPriceFeed({ 'UCT/USDU': 1.25 });
  const killSwitch = opts.killSwitch ?? new KillSwitch({ maxConsecutiveFailures: 3 });
  const pnl = opts.pnl ?? new PnlTracker(DEFAULT_MAX_DAILY_LOSS);
  const pairs = buildPairs(opts.coinDecimals ?? {});

  const inventory = opts.snapshot
    ? Inventory.restore(RISK_LIMITS, opts.snapshot.inventory)
    : opts.seedDemo === false
      ? new Inventory(RISK_LIMITS) // live: start empty, fill from chain
      : seedInventory(new Inventory(RISK_LIMITS));

  const engine = new QuoteEngine({ pairs, priceFeed, inventory, now, preLockBounds: PRELOCK_BOUNDS });
  const negotiation = new NegotiationEngine({
    engine,
    inventory,
    pairs,
    now,
    swapTimeoutSec: 1800, // within PRELOCK_BOUNDS; short enough to limit liquidity lock
    killSwitch,
  });

  if (opts.snapshot) negotiation.restore(opts.snapshot.sessions);

  return { pairs, inventory, priceFeed, engine, negotiation, killSwitch, pnl };
}

/** Demo starting balances — replaced by on-chain balances in live mode. */
function seedInventory(inv: Inventory): Inventory {
  inv.setBalance(UCT.coinId, 10_000_00000000n); // 10,000 UCT
  inv.setBalance(USDU.coinId, 250_000_000000n); // 250,000 USDU
  return inv;
}
