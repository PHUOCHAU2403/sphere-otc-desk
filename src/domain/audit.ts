/**
 * Append-only, hash-chained audit log. Every money/risk event is recorded with
 * a hash linking it to the previous record, so truncation or tampering of the
 * file is detectable (`verifyChain`). The domain defines the format + a pure
 * verifier; the concrete file writer (node crypto + fs) lives in adapters.
 */

export interface AuditEvent {
  readonly seq: number;
  readonly ts: number;
  readonly type: string;
  readonly data: Record<string, unknown>;
  readonly prevHash: string;
  readonly hash: string;
}

export interface AuditLog {
  append(type: string, data: Record<string, unknown>): Promise<void>;
}

/** No-op log for the sim / tests. */
export class NullAuditLog implements AuditLog {
  async append(): Promise<void> {
    /* discard */
  }
}

export const GENESIS_HASH = '0'.repeat(64);

/** JSON replacer that renders bigint as a decimal string (stable, lossless). */
export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * Canonical pre-image hashed for a record. Field order is fixed so the digest is
 * reproducible. `data` is serialized with the bigint replacer.
 */
export function canonical(
  seq: number,
  ts: number,
  type: string,
  data: Record<string, unknown>,
  prevHash: string,
): string {
  return JSON.stringify({ seq, ts, type, data, prevHash }, bigintReplacer);
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly count: number;
  /** seq of the first record that fails the chain, if any. */
  readonly brokenAt?: number;
}

/**
 * Verify a full chain. `sha256` is injected so this stays pure/portable.
 * Checks: genesis link, monotonic seq, prevHash linkage, and hash integrity.
 */
export function verifyChain(events: readonly AuditEvent[], sha256: (s: string) => string): VerifyResult {
  let prev = GENESIS_HASH;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    const expectedHash = sha256(canonical(e.seq, e.ts, e.type, e.data, e.prevHash));
    if (e.seq !== i + 1 || e.prevHash !== prev || e.hash !== expectedHash) {
      return { ok: false, count: events.length, brokenAt: e.seq };
    }
    prev = e.hash;
  }
  return { ok: true, count: events.length };
}
