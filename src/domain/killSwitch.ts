/**
 * Kill-switch + circuit breaker. Gates every entry point that creates *new*
 * risk (quoting, accepting proposals, opening swaps). In-flight deals are never
 * blocked — they must settle or be refunded by the escrow regardless.
 *
 * Two ways to halt:
 *   - manual:  operator calls halt() (wired to a control file in index.ts)
 *   - automatic: the breaker trips after N consecutive swap failures, the classic
 *     "something is wrong with the escrow / counterparties — stop taking risk".
 */

export interface CircuitConfig {
  /** Trip the breaker after this many consecutive swap failures. */
  readonly maxConsecutiveFailures: number;
}

export interface KillSwitchState {
  readonly manualHalt: boolean;
  readonly autoHalt: boolean;
  readonly consecutiveFailures: number;
  readonly reason: string;
}

export class KillSwitch {
  private manualHalt = false;
  private autoHalt = false;
  private reasonStr = '';
  private consecutiveFailures = 0;

  constructor(private readonly cfg: CircuitConfig) {}

  isHalted(): boolean {
    return this.manualHalt || this.autoHalt;
  }

  reason(): string {
    return this.reasonStr;
  }

  /** Manual halt (operator). Idempotent. */
  halt(reason: string): void {
    this.manualHalt = true;
    this.reasonStr = reason;
  }

  /** Clear both manual and auto halt, and reset the breaker. */
  resume(): void {
    this.manualHalt = false;
    this.autoHalt = false;
    this.consecutiveFailures = 0;
    this.reasonStr = '';
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  /** Record a swap failure. Returns true if this one tripped the breaker. */
  recordFailure(): boolean {
    this.consecutiveFailures += 1;
    if (!this.autoHalt && this.consecutiveFailures >= this.cfg.maxConsecutiveFailures) {
      this.autoHalt = true;
      this.reasonStr = `circuit breaker: ${this.consecutiveFailures} consecutive swap failures`;
      return true;
    }
    return false;
  }

  state(): KillSwitchState {
    return {
      manualHalt: this.manualHalt,
      autoHalt: this.autoHalt,
      consecutiveFailures: this.consecutiveFailures,
      reason: this.reasonStr,
    };
  }

  // --- persistence ---

  toSnapshot(): KillSwitchState {
    return this.state();
  }

  /**
   * Restore a breaker state across restarts. A latched halt (manual or auto)
   * survives the restart so the desk does NOT boot back into a hot state after a
   * crash that was caused by the very condition that tripped it. Note: a manual
   * halt may be overridden immediately by the control-file watcher if the HALT
   * file is gone — that is intentional (operator removed it = resume).
   */
  static restore(cfg: CircuitConfig, snap: KillSwitchState): KillSwitch {
    const ks = new KillSwitch(cfg);
    ks.manualHalt = snap.manualHalt;
    ks.autoHalt = snap.autoHalt;
    ks.consecutiveFailures = snap.consecutiveFailures;
    ks.reasonStr = snap.reason;
    return ks;
  }
}
