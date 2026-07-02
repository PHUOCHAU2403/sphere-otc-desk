/**
 * OTC trading logic for the Sphere Connect dApp.
 *
 * The dApp is the *taker*: the connected user negotiates with our headless desk
 * agent (@hau-otc-desk) over encrypted DMs and settles through our escrow agent
 * (@hau-escrow) — exactly the same wire protocol the CLI taker speaks, but each
 * money-moving step goes through a wallet-approved Connect intent (`dm`, `send`).
 */

import { RPC_METHODS, INTENT_ACTIONS } from '@unicitylabs/sphere-sdk/connect';
import type { ConversationPage, DirectMessage, PeerInfo } from './types';

export const DESK = '@' + (import.meta.env.VITE_DESK_NAMETAG || 'hau-otc-desk').replace(/^@/, '');
export const ESCROW = '@' + (import.meta.env.VITE_ESCROW_NAMETAG || 'hau-escrow').replace(/^@/, '');

/** Testnet2 coin registry (lowercase 64-hex ids, as the `send` intent requires). */
export const COINS = {
  UCT: { hex: 'f581d30f593e4b369d684a4563b5246f07b1d265f7178a2c0a82b81f39c24dc0', decimals: 18 },
  USDU: { hex: 'e210f98956f564bfe67ee94fddd386b5157f660d1957169b391f962093a2da2a', decimals: 6 },
} as const;

const coinOf = (sym: string): { hex: string; decimals: number } | undefined =>
  (COINS as Record<string, { hex: string; decimals: number }>)[sym];

export type WalletFns = {
  query: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
  intent: <T = unknown>(action: string, params: Record<string, unknown>) => Promise<T>;
};

// ---- amount helpers (base units <-> human) --------------------------------

export function toBase(human: string | number, decimals: number): string {
  const s = String(human).trim();
  const [w, f = ''] = s.split('.');
  const frac = (f + '0'.repeat(decimals)).slice(0, decimals);
  return (BigInt(w || '0') * 10n ** BigInt(decimals) + BigInt(frac || '0')).toString();
}

export function toHuman(base: string, decimals: number): string {
  const neg = base.startsWith('-');
  const s = (neg ? base.slice(1) : base).padStart(decimals + 1, '0');
  const w = s.slice(0, -decimals) || '0';
  const f = s.slice(-decimals).replace(/0+$/, '');
  return (neg ? '-' : '') + w + (f ? '.' + f : '');
}

// ---- wire protocol --------------------------------------------------------

export interface Quote {
  rfqId: string;
  side: 'buy' | 'sell';
  priceScaled: string; // desk's scaled price (÷1e8)
  baseAmount: string; // UCT base units
  quoteAmount: string; // USDU base units
}

export interface SettleTerms {
  rfqId: string;
  swapId: string;
  escrow: string;
  payCoin: string; // symbol the taker pays (USDU)
  payAmount: string; // base units
  getCoin: string; // symbol the taker receives (UCT)
  getAmount: string;
}

const tryJson = (s: string): Record<string, unknown> | null => {
  try {
    const o = JSON.parse(s) as unknown;
    return o && typeof o === 'object' ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resolve a nametag to its chain pubkey (the key GET_MESSAGES uses). */
async function peerPubkey(w: WalletFns, nametag: string): Promise<string> {
  const info = await w.query<PeerInfo>(RPC_METHODS.RESOLVE, { identifier: nametag });
  const pk = info?.chainPubkey;
  if (!pk) throw new Error(`cannot resolve ${nametag}`);
  return pk;
}

/**
 * Poll the conversation with `nametag` until a message whose parsed JSON body
 * satisfies `match` arrives, or `timeoutMs` elapses.
 */
async function waitForDM(
  w: WalletFns,
  nametag: string,
  match: (body: Record<string, unknown>) => boolean,
  timeoutMs = 90_000,
): Promise<Record<string, unknown>> {
  const pubkey = await peerPubkey(w, nametag);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = await w
      .query<ConversationPage>(RPC_METHODS.GET_MESSAGES, { peerPubkey: pubkey, limit: 20 })
      .catch(() => null);
    const msgs: DirectMessage[] = page?.messages ?? [];
    // newest last — scan from the end
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (!m || m.senderPubkey !== pubkey) continue; // only messages FROM the peer
      const body = tryJson(m.content);
      if (body && match(body)) return body;
    }
    await sleep(2500);
  }
  throw new Error(`timed out waiting for a reply from ${nametag}`);
}

// ---- flows ----------------------------------------------------------------

/** Step 1: send an RFQ to the desk and return its firm quote (or throw on reject). */
export async function requestQuote(
  w: WalletFns,
  side: 'buy' | 'sell',
  amountUct: number,
): Promise<Quote> {
  const rfqId = crypto.randomUUID().slice(0, 8);
  const baseAmount = toBase(amountUct, COINS.UCT.decimals);
  await w.intent(INTENT_ACTIONS.DM, {
    to: DESK,
    message: JSON.stringify({ t: 'rfq', rfqId, side, base: 'UCT', baseAmount }),
  });
  const body = await waitForDM(
    w,
    DESK,
    (b) => b['rfqId'] === rfqId && (b['t'] === 'quote' || b['t'] === 'reject'),
  );
  if (body['t'] === 'reject') throw new Error('desk rejected: ' + String(body['reason'] ?? 'no reason'));
  return {
    rfqId,
    side,
    priceScaled: String(body['priceScaled']),
    baseAmount: String(body['baseAmount']),
    quoteAmount: String(body['quoteAmount']),
  };
}

export type SettleProgress = (stage: string) => void;

/**
 * Step 2: accept the quote → the desk opens the escrow swap and DMs us `settle`
 * → we deposit our leg to the escrow (memo = swapId) → the escrow settles and we
 * receive the bought coin. Returns the settled terms.
 */
export async function acceptAndSettle(
  w: WalletFns,
  quote: Quote,
  onProgress: SettleProgress = () => {},
): Promise<SettleTerms> {
  onProgress('Accepting quote…');
  await w.intent(INTENT_ACTIONS.DM, { to: DESK, message: JSON.stringify({ t: 'accept', rfqId: quote.rfqId }) });

  onProgress('Desk is opening the escrow swap…');
  const s = await waitForDM(w, DESK, (b) => b['t'] === 'settle' && b['rfqId'] === quote.rfqId);
  const terms: SettleTerms = {
    rfqId: quote.rfqId,
    swapId: String(s['swapId']),
    escrow: String(s['escrow'] ?? ESCROW),
    payCoin: String(s['payCoin']),
    payAmount: String(s['payAmount']),
    getCoin: String(s['getCoin']),
    getAmount: String(s['getAmount']),
  };

  const coin = coinOf(terms.payCoin);
  if (!coin) throw new Error('unknown pay coin ' + terms.payCoin);

  onProgress(`Approve paying ${toHuman(terms.payAmount, coin.decimals)} ${terms.payCoin} to the escrow…`);
  await w.intent(INTENT_ACTIONS.SEND, {
    to: terms.escrow,
    amount: terms.payAmount,
    coinId: coin.hex,
    memo: terms.swapId,
  });

  onProgress('Deposited — waiting for the escrow to settle both legs…');
  await waitForDM(w, terms.escrow, (b) => b['t'] === 'escrow_settled' && b['swapId'] === terms.swapId, 120_000);

  onProgress('Settled ✓');
  return terms;
}
