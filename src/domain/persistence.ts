/**
 * Persistence contract for the desk's durable state. The domain defines the
 * shape; concrete stores (file, redis, …) live in adapters.
 */

import type { InventorySnapshot } from './inventory.js';
import type { SessionSnapshot } from './negotiation.js';
import type { KillSwitchState } from './killSwitch.js';
import type { PnlSnapshot } from './pnl.js';

export interface DeskSnapshot {
  readonly version: 1;
  readonly updatedAt: number;
  readonly inventory: InventorySnapshot;
  readonly sessions: readonly SessionSnapshot[];
  /** Optional for backward compatibility with pre-safety-rails snapshots. */
  readonly killSwitch?: KillSwitchState;
  /** Daily P&L baseline; optional for backward compatibility. */
  readonly pnl?: PnlSnapshot;
}

export interface Store {
  load(): Promise<DeskSnapshot | null>;
  save(snapshot: DeskSnapshot): Promise<void>;
}

/** No-op store for the sim / tests — nothing is persisted. */
export class MemoryStore implements Store {
  private state: DeskSnapshot | null = null;
  async load(): Promise<DeskSnapshot | null> {
    return this.state;
  }
  async save(snapshot: DeskSnapshot): Promise<void> {
    this.state = snapshot;
  }
}
