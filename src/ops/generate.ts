/**
 * Library: build the dashboard HTML from a state file + audit log. No top-level
 * side effects so it can be imported by both the CLI and the demo.
 */

import { writeFile } from 'node:fs/promises';
import { FileStore } from '../adapters/fileStore.js';
import { FileAuditLog } from '../adapters/fileAuditLog.js';
import { buildModel, type CoinMeta } from './metrics.js';
import { renderDashboard } from './render.js';

export const COIN_META: Readonly<Record<string, CoinMeta>> = {
  UCT: { symbol: 'UCT', decimals: 18 }, // real on-chain decimals (testnet2)
  USDU: { symbol: 'USDU', decimals: 6 },
};

export async function generateDashboard(
  statePath: string,
  auditPath: string,
  outPath: string,
): Promise<void> {
  const snapshot = await new FileStore(statePath).load();
  const events = await FileAuditLog.readEvents(auditPath);
  const integrity = await FileAuditLog.verifyFile(auditPath);
  const model = buildModel(snapshot, events, COIN_META, integrity, Date.now());
  await writeFile(outPath, renderDashboard(model), 'utf8');
}
