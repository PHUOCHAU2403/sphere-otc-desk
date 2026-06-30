/**
 * Render a DashboardModel into a self-contained, dark "Grafana-style" HTML
 * document. No external assets — drop the file in a browser and screenshot it.
 */

import type { DashboardModel, EventRow, CountRow } from './metrics.js';

const C = {
  bg: '#0e1013',
  panel: '#181b1f',
  panel2: '#1f2329',
  border: '#23262b',
  text: '#d8d9da',
  muted: '#8e8e93',
  green: '#73bf69',
  red: '#f2495c',
  yellow: '#ff9830',
  blue: '#5794f2',
  purple: '#b877d9',
};

/** Full standalone HTML document (file / browser). */
export function renderDashboard(m: DashboardModel): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>OTC Desk — Ops</title>
<style>:root{color-scheme:dark}html,body{margin:0;background:${C.bg}}</style>
${renderFragment(m)}
</head><body></body></html>`;
}

/**
 * Self-contained fragment (scoped under `.otc`) for embedding — e.g. inline in
 * chat. Carries its own dark background so it reads as one Grafana-style panel.
 */
export function renderFragment(m: DashboardModel): string {
  const halted = m.status.state === 'HALTED';
  const statusColor = halted ? C.red : C.green;
  const pnlColor = m.dailyPnl ? (m.dailyPnl.startsWith('-') ? C.red : C.green) : C.muted;

  return `<style>
  .otc { background:${C.bg}; color:${C.text}; padding:22px; border-radius:10px;
         font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; -webkit-font-smoothing:antialiased; }
  .otc * { box-sizing:border-box; }
  .otc .mono { font-family:ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace; }
  .otc .head { display:flex; align-items:center; justify-content:space-between; margin-bottom:18px; }
  .otc .brand { font-size:13px; letter-spacing:.18em; text-transform:uppercase; color:${C.muted}; }
  .otc .brand b { color:${C.text}; font-weight:600; }
  .otc .pill { display:inline-flex; align-items:center; gap:8px; padding:6px 14px; border-radius:999px;
          font-size:12px; font-weight:600; letter-spacing:.08em; border:1px solid ${C.border}; background:${C.panel}; }
  .otc .dot { width:8px; height:8px; border-radius:50%; box-shadow:0 0 8px currentColor; }
  .otc .meta { font-size:12px; color:${C.muted}; text-align:right; line-height:1.6; }
  .otc .grid { display:grid; gap:14px; }
  .otc .stats { grid-template-columns:repeat(6,1fr); margin-bottom:14px; }
  .otc .cols { grid-template-columns:1.15fr 1fr; }
  .otc .panel { background:${C.panel}; border:1px solid ${C.border}; border-radius:8px; padding:14px 16px; }
  .otc .ptitle { font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:${C.muted}; margin:0 0 12px; font-weight:600; }
  .otc .stat .label { font-size:11px; letter-spacing:.1em; text-transform:uppercase; color:${C.muted}; }
  .otc .stat .num { font-size:28px; font-weight:600; margin-top:6px; line-height:1; }
  .otc .stat .unit { font-size:11px; color:${C.muted}; margin-left:4px; }
  .otc table { width:100%; border-collapse:collapse; font-size:13px; }
  .otc th { text-align:left; font-size:10px; letter-spacing:.1em; text-transform:uppercase; color:${C.muted};
       font-weight:600; padding:0 0 8px; border-bottom:1px solid ${C.border}; }
  .otc td { padding:9px 0; border-bottom:1px solid ${C.border}; }
  .otc tr:last-child td { border-bottom:none; }
  .otc .num-c { text-align:right; }
  .otc .badge { display:inline-block; padding:2px 9px; border-radius:5px; font-size:11px; font-weight:600; }
  .otc .bar-row { display:grid; grid-template-columns:150px 1fr 44px; align-items:center; gap:10px; margin-bottom:9px; font-size:12px; }
  .otc .bar-track { height:8px; background:${C.panel2}; border-radius:4px; overflow:hidden; }
  .otc .bar-fill { height:100%; border-radius:4px; }
  .otc .reason { margin:0 0 14px; font-size:12px; color:${C.yellow}; background:${C.panel2};
            border-left:3px solid ${C.yellow}; padding:8px 12px; border-radius:4px; }
  .otc .muted { color:${C.muted}; }
  .otc .foot { margin-top:16px; font-size:11px; color:${C.muted}; display:flex; justify-content:space-between; }
</style>
<div class="otc">
  <div class="head">
    <div class="brand">AGENTSPHERE · <b>OTC DESK</b> — OPS</div>
    <div style="display:flex; align-items:center; gap:16px;">
      <span class="pill" style="color:${statusColor}"><span class="dot" style="background:${statusColor}"></span>${m.status.state}</span>
      <div class="meta">
        ${m.integrity.ok ? `<span style="color:${C.green}">⛓ audit verified · ${m.integrity.count} events</span>`
          : `<span style="color:${C.red}">⛓ audit BROKEN @ seq ${m.integrity.brokenAt}</span>`}<br/>
        ${new Date(m.generatedAt).toISOString().replace('T', ' ').slice(0, 19)} UTC
      </div>
    </div>
  </div>

  ${halted ? `<div class="reason">HALTED — ${esc(m.status.reason)}</div>` : ''}

  <div class="grid stats">
    ${stat('Equity', m.equity ?? '—', 'USDU', C.text)}
    ${stat('Daily P&L', m.dailyPnl ?? '—', m.pnlDay ? 'USDU · ' + m.pnlDay : 'USDU', pnlColor)}
    ${stat('Open Exposure', m.openExposure, 'USDU', C.text)}
    ${stat('Open Deals', String(m.stats.openDeals), '', C.blue)}
    ${stat('Swaps Done', String(m.stats.swapsCompleted), '', C.green)}
    ${stat('Swaps Failed', String(m.stats.swapsFailed), m.status.consecutiveFailures ? `${m.status.consecutiveFailures} in a row` : '', m.stats.swapsFailed ? C.red : C.text)}
  </div>

  <div class="grid cols">
    <div class="panel">
      <p class="ptitle">Inventory</p>
      <table><thead><tr><th>Asset</th><th class="num-c">Free</th><th class="num-c">Reserved</th></tr></thead>
      <tbody>${m.inventory.map(invRow).join('') || emptyRow(3)}</tbody></table>
    </div>
    <div class="panel">
      <p class="ptitle">Event Mix</p>
      ${eventMix(m.eventCounts)}
    </div>
  </div>

  <div style="height:14px"></div>

  <div class="panel">
    <p class="ptitle">Open Deals (${m.deals.length})</p>
    <table><thead><tr><th>RFQ</th><th>Counterparty</th><th>State</th><th>Detail</th><th>Swap</th></tr></thead>
    <tbody>${m.deals.map(dealRow).join('') || emptyRow(5)}</tbody></table>
  </div>

  <div style="height:14px"></div>

  <div class="panel">
    <p class="ptitle">Recent Activity</p>
    <table><thead><tr><th>When</th><th>Event</th><th>Detail</th></tr></thead>
    <tbody>${m.recent.map((e) => eventRow(e, m.generatedAt)).join('') || emptyRow(3)}</tbody></table>
  </div>

  <div class="foot">
    <span>${m.stats.quotes} quotes · ${m.stats.dealsAgreed} agreed · ${m.stats.rejects} rejected</span>
    <span>${m.totalEvents} audit events</span>
  </div>
</div>`;
}

function stat(label: string, num: string, unit: string, color: string): string {
  return `<div class="panel stat"><div class="label">${label}</div>
    <div class="num mono" style="color:${color}">${esc(num)}<span class="unit">${esc(unit)}</span></div></div>`;
}

function invRow(r: { symbol: string; free: string; reserved: string }): string {
  return `<tr><td>${esc(r.symbol)}</td><td class="num-c mono">${esc(r.free)}</td>
    <td class="num-c mono muted">${esc(r.reserved)}</td></tr>`;
}

function dealRow(d: { id: string; peer: string; state: string; summary: string; swapId: string }): string {
  return `<tr><td class="mono">${esc(d.id)}</td><td>${esc(d.peer)}</td>
    <td><span class="badge" style="background:${badgeBg(stateColor(d.state))};color:${stateColor(d.state)}">${esc(d.state)}</span></td>
    <td class="mono muted">${esc(d.summary)}</td><td class="mono muted">${esc(d.swapId)}</td></tr>`;
}

function eventRow(e: EventRow, now: number): string {
  const col = typeColor(e.type);
  return `<tr><td class="mono muted">${ago(e.ts, now)}</td>
    <td><span class="badge" style="background:${badgeBg(col)};color:${col}">${esc(e.type)}</span></td>
    <td class="mono muted">${esc(e.summary)}</td></tr>`;
}

function eventMix(counts: readonly CountRow[]): string {
  const max = Math.max(1, ...counts.map((c) => c.count));
  return counts
    .slice(0, 9)
    .map((c) => {
      const col = typeColor(c.type);
      const w = Math.round((c.count / max) * 100);
      return `<div class="bar-row"><span class="muted mono">${esc(c.type)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${w}%;background:${col}"></span></span>
        <span class="num-c mono">${c.count}</span></div>`;
    })
    .join('');
}

function emptyRow(cols: number): string {
  return `<tr><td colspan="${cols}" class="muted" style="padding:14px 0;text-align:center">— none —</td></tr>`;
}

function stateColor(s: string): string {
  return s === 'agreed' ? C.green : s === 'quoted' ? C.blue : C.muted;
}

function typeColor(t: string): string {
  if (t.includes('completed') || t === 'boot') return C.green;
  if (t.includes('failed') || t.includes('cancelled') || t.includes('halted')) return C.red;
  if (t.includes('rejected') || t.includes('trueup')) return C.yellow;
  if (t.includes('deposit')) return C.purple;
  if (t === 'pnl_mark' || t === 'shutdown' || t.includes('rolled') || t.includes('resumed')) return C.muted;
  return C.blue;
}

function badgeBg(color: string): string {
  return color + '22'; // 13% alpha tint
}

function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );
}
