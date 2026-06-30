/**
 * File-backed hash-chained audit log (JSON Lines). Each append fsyncs so a crash
 * cannot lose an acknowledged record. The chain continues across restarts by
 * reading the last record's hash on open.
 */

import { createHash } from 'node:crypto';
import { open, readFile, mkdir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  canonical,
  verifyChain,
  bigintReplacer,
  GENESIS_HASH,
  type AuditEvent,
  type AuditLog,
  type VerifyResult,
} from '../domain/audit.js';

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

export class FileAuditLog implements AuditLog {
  private handle: FileHandle | null = null;
  private lastHash = GENESIS_HASH;
  private lastSeq = 0;
  private init: Promise<void> | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  private async ensureOpen(): Promise<void> {
    if (this.init) return this.init;
    this.init = (async () => {
      await mkdir(dirname(this.path), { recursive: true });
      // Recover the chain tail from any existing log.
      try {
        const existing = await readFile(this.path, 'utf8');
        const lines = existing.split('\n').filter((l) => l.trim().length > 0);
        if (lines.length > 0) {
          const last = JSON.parse(lines[lines.length - 1]!) as AuditEvent;
          this.lastHash = last.hash;
          this.lastSeq = last.seq;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      this.handle = await open(this.path, 'a');
    })();
    return this.init;
  }

  async append(type: string, data: Record<string, unknown>): Promise<void> {
    await this.ensureOpen();
    // Serialize appends so seq/hash never race.
    this.writeChain = this.writeChain.then(async () => {
      const seq = this.lastSeq + 1;
      const ts = Date.now();
      const prevHash = this.lastHash;
      const hash = sha256(canonical(seq, ts, type, data, prevHash));
      const event: AuditEvent = { seq, ts, type, data, prevHash, hash };
      // bigintReplacer keeps the on-disk form identical to the hash pre-image.
      await this.handle!.appendFile(JSON.stringify(event, bigintReplacer) + '\n');
      await this.handle!.sync(); // durable before we acknowledge
      this.lastHash = hash;
      this.lastSeq = seq;
    });
    return this.writeChain;
  }

  async close(): Promise<void> {
    await this.writeChain;
    if (this.handle) await this.handle.close();
  }

  /** Read all events from a log file (empty array if the file is missing). */
  static async readEvents(path: string): Promise<AuditEvent[]> {
    try {
      const raw = await readFile(path, 'utf8');
      return raw
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as AuditEvent);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  /** Read and verify a log file end-to-end. */
  static async verifyFile(path: string): Promise<VerifyResult> {
    const events = await FileAuditLog.readEvents(path);
    return verifyChain(events, sha256);
  }
}
