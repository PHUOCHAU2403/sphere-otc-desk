/**
 * Atomic JSON file store for the desk snapshot. Writes to a temp file then
 * renames, so a crash mid-write never corrupts the existing snapshot.
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DeskSnapshot, Store } from '../domain/persistence.js';

export class FileStore implements Store {
  constructor(private readonly path: string) {}

  async load(): Promise<DeskSnapshot | null> {
    try {
      const raw = await readFile(this.path, 'utf8');
      const snap = JSON.parse(raw) as DeskSnapshot;
      if (snap.version !== 1) throw new Error(`unsupported snapshot version ${snap.version}`);
      return snap;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; // first run
      throw err;
    }
  }

  async save(snapshot: DeskSnapshot): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
    await rename(tmp, this.path); // atomic on the same filesystem
  }
}
