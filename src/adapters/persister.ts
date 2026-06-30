/**
 * Debounced snapshot writer. The desk calls `schedule()` after any state change;
 * writes are coalesced over a short window so a burst of events produces one
 * save. `flush()` forces an immediate write (use on shutdown).
 */

import type { Inventory } from '../domain/inventory.js';
import type { NegotiationEngine } from '../domain/negotiation.js';
import type { KillSwitch } from '../domain/killSwitch.js';
import type { PnlTracker } from '../domain/pnl.js';
import type { Store, DeskSnapshot } from '../domain/persistence.js';

export interface PersisterDeps {
  readonly inventory: Inventory;
  readonly negotiation: NegotiationEngine;
  readonly killSwitch: KillSwitch;
  readonly pnl: PnlTracker;
  readonly store: Store;
  /** Debounce window in ms (default 250). */
  readonly debounceMs?: number;
}

export class Persister {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> | null = null;
  private readonly debounceMs: number;

  constructor(private readonly deps: PersisterDeps) {
    this.debounceMs = deps.debounceMs ?? 250;
  }

  private capture(): DeskSnapshot {
    return {
      version: 1,
      updatedAt: Date.now(),
      inventory: this.deps.inventory.toSnapshot(),
      sessions: this.deps.negotiation.toSnapshot(),
      killSwitch: this.deps.killSwitch.toSnapshot(),
      pnl: this.deps.pnl.toSnapshot(),
    };
  }

  /** Request a save soon. Safe to call on every state change. */
  schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
  }

  /** Write now, serializing concurrent calls. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Chain saves so two flushes never interleave a write.
    this.saving = (this.saving ?? Promise.resolve()).then(() =>
      this.deps.store.save(this.capture()),
    );
    await this.saving;
  }
}
