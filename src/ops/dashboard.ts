/**
 * Generate the ops dashboard HTML from the live state file + audit log.
 *   npx tsx src/ops/dashboard.ts   (or `npm run dashboard`)
 *
 * Reads STATE_FILE / AUDIT_FILE (same env as the live agent) and writes
 * DASHBOARD_OUT. Safe to run anytime — it never touches the agent's state.
 */

import { generateDashboard } from './generate.js';

const env = (k: string, d: string): string => process.env[k] ?? d;

async function main(): Promise<void> {
  const statePath = env('STATE_FILE', './wallet-data/desk-state.json');
  const auditPath = env('AUDIT_FILE', './wallet-data/audit.jsonl');
  const outPath = env('DASHBOARD_OUT', './wallet-data/dashboard.html');
  await generateDashboard(statePath, auditPath, outPath);
  console.log(`dashboard written → ${outPath}`);
}

main().catch((err) => {
  console.error('dashboard error:', err);
  process.exit(1);
});
