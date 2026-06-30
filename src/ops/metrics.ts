/**
 * Build a dashboard model from the persisted snapshot + the audit log. Pure: no
 * file IO, no rendering — just the numbers the dashboard shows.
 */

import type { DeskSnapshot } from '../domain/persistence.js';
import type { AuditEvent, VerifyResult } from '../domain/audit.js';

export interface CoinMeta {
  readonly symbol: string;
  readonly decimals: number;
}

export interface StatusModel {
  readonly state: 'RUNNING' | 'HALTED';
  readonly reason: string;
  readonly consecutiveFailures: number;
}

export interface InventoryRow {
  readonly symbol: string;
  readonly free: string;
  readonly reserved: string;
}

export interface DealRow {
  readonly id: string;
  readonly peer: string;
  readonly state: string;
  readonly summary: string;
  readonly swapId: string;
}

export interface CountRow {
  readonly type: string;
  readonly count: number;
}

export interface EventRow {
  readonly ts: number;
  readonly type: string;
  readonly summary: string;
}

export interface DashboardModel {
  readonly generatedAt: number;
  readonly status: StatusModel;
  readonly equity: string | null;
  readonly dailyPnl: string | null;
  readonly pnlDay: string | null;
  readonly openExposure: string;
  readonly stats: {
    readonly quotes: number;
    readonly dealsAgreed: number;
    readonly swapsCompleted: number;
    readonly swapsFailed: number;
    readonly rejects: number;
    readonly openDeals: number;
  };
  readonly inventory: readonly InventoryRow[];
  readonly deals: readonly DealRow[];
  readonly eventCounts: readonly CountRow[];
  readonly recent: readonly EventRow[];
  readonly integrity: VerifyResult;
  readonly totalEvents: number;
}

const NUMERAIRE_DECIMALS = 6; // USDU

export function buildModel(
  snapshot: DeskSnapshot | null,
  events: readonly AuditEvent[],
  coinMeta: Readonly<Record<string, CoinMeta>>,
  integrity: VerifyResult,
  now: number,
): DashboardModel {
  const ks = snapshot?.killSwitch;
  const halted = !!ks && (ks.manualHalt || ks.autoHalt);
  const status: StatusModel = {
    state: halted ? 'HALTED' : 'RUNNING',
    reason: ks?.reason ?? '',
    consecutiveFailures: ks?.consecutiveFailures ?? 0,
  };

  // Latest mark-to-market from the most recent pnl_mark event.
  const lastMark = lastOf(events, 'pnl_mark');
  const equity = lastMark ? fmt(str(lastMark.data['equity']), NUMERAIRE_DECIMALS) : null;
  const dailyPnl = lastMark ? fmtSigned(str(lastMark.data['dailyPnl']), NUMERAIRE_DECIMALS) : null;
  const pnlDay = lastMark ? str(lastMark.data['day']) : null;

  // Inventory: free balances + reserved (summed per coin), in human units.
  const reservedByCoin = new Map<string, bigint>();
  for (const r of Object.values(snapshot?.inventory.reserved ?? {})) {
    reservedByCoin.set(r.coin, (reservedByCoin.get(r.coin) ?? 0n) + BigInt(r.amount));
  }
  const inventory: InventoryRow[] = Object.entries(snapshot?.inventory.balances ?? {}).map(
    ([coin, free]) => {
      const meta = coinMeta[coin];
      const dec = meta?.decimals ?? 0;
      return {
        symbol: meta?.symbol ?? coin,
        free: fmt(free, dec),
        reserved: fmt((reservedByCoin.get(coin) ?? 0n).toString(), dec),
      };
    },
  );

  // Open (non-terminal) deals from the session snapshot.
  const deals: DealRow[] = (snapshot?.sessions ?? []).map((s) => ({
    id: s.rfqId,
    peer: s.peer,
    state: s.state,
    summary: dealSummary(s, coinMeta),
    swapId: s.swapId ? short(s.swapId) : '—',
  }));

  // Event counts (all time) + key stats.
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  const eventCounts: CountRow[] = [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);
  const c = (t: string): number => counts.get(t) ?? 0;

  const recent: EventRow[] = events
    .slice(-14)
    .reverse()
    .map((e) => ({ ts: e.ts, type: e.type, summary: summarize(e, coinMeta) }));

  return {
    generatedAt: now,
    status,
    equity,
    dailyPnl,
    pnlDay,
    openExposure: fmt(snapshot?.inventory.openExposure ?? '0', NUMERAIRE_DECIMALS),
    stats: {
      quotes: c('quote_issued'),
      dealsAgreed: c('deal_agreed') + c('proposal_accepted'),
      swapsCompleted: c('swap_completed'),
      swapsFailed: c('swap_failed') + c('swap_cancelled'),
      rejects: c('rfq_rejected') + c('proposal_rejected'),
      openDeals: deals.filter((d) => d.state === 'quoted' || d.state === 'agreed').length,
    },
    inventory,
    deals,
    eventCounts,
    recent,
    integrity,
    totalEvents: events.length,
  };
}

// --- helpers ---

function lastOf(events: readonly AuditEvent[], type: string): AuditEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) if (events[i]!.type === type) return events[i];
  return undefined;
}

function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v);
}

function short(s: string): string {
  return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}

/** smallest-units string → human number with thousands separators. */
export function fmt(amount: string, decimals: number): string {
  if (!amount) return '0';
  const neg = amount.startsWith('-');
  const digits = (neg ? amount.slice(1) : amount).padStart(decimals + 1, '0');
  const intPart = digits.slice(0, digits.length - decimals) || '0';
  const fracPart = decimals > 0 ? digits.slice(digits.length - decimals) : '';
  const intGrouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const trimmedFrac = fracPart.replace(/0+$/, '');
  return (neg ? '-' : '') + intGrouped + (trimmedFrac ? '.' + trimmedFrac : '');
}

function fmtSigned(amount: string, decimals: number): string {
  const f = fmt(amount, decimals);
  return amount.startsWith('-') ? f : '+' + f;
}

function px(scaled: string): string {
  if (!scaled) return '';
  return (Number(scaled) / 1e8).toFixed(6);
}

function dealSummary(s: DeskSnapshot['sessions'][number], meta: Readonly<Record<string, CoinMeta>>): string {
  const q = s.quote;
  const baseDec = meta[q.baseSymbol]?.decimals ?? 8;
  return `${s.state === 'agreed' ? '⇅' : '◷'} ${q.side} ${fmt(q.baseAmount, baseDec)} ${q.baseSymbol} @ ${px(q.priceScaled)}`;
}

function summarize(e: AuditEvent, meta: Readonly<Record<string, CoinMeta>>): string {
  const d = e.data;
  switch (e.type) {
    case 'quote_issued':
      return `${str(d['base'])} ${fmt(str(d['baseAmount']), meta[str(d['base'])]?.decimals ?? 8)} @ ${px(str(d['priceScaled']))} → ${str(d['rfqId'])}`;
    case 'deal_agreed':
      return `${str(d['rfqId'])} with ${str(d['counterparty'])}`;
    case 'proposal_accepted':
      return `${str(d['counterparty'])} ${short(str(d['swapId']))}`;
    case 'proposal_rejected':
    case 'rfq_rejected':
      return `${str(d['rfqId'] ?? d['swapId'])}: ${str(d['reason'])}`;
    case 'swap_proposed':
      return `${str(d['rfqId'])} → ${short(str(d['swapId']))}`;
    case 'swap_completed':
      return `${short(str(d['swapId']))} verified=${str(d['payoutVerified'])}`;
    case 'swap_failed':
    case 'swap_cancelled':
      return `${short(str(d['swapId']))}: ${str(d['error'] ?? d['reason'])}`;
    case 'deposit_sent':
      return short(str(d['swapId']));
    case 'pnl_mark':
      return `equity ${fmt(str(d['equity']), 6)} · pnl ${fmtSigned(str(d['dailyPnl']), 6)}`;
    case 'kill_halted':
      return str(d['reason']);
    case 'ledger_trueup':
      return Array.isArray(d['changes']) ? `${(d['changes'] as unknown[]).length} change(s)` : '';
    case 'boot':
      return str(d['identity']);
    default:
      return '';
  }
}
