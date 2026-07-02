import { useCallback, useEffect, useMemo, useState } from 'react';
import { RPC_METHODS } from '@unicitylabs/sphere-sdk/connect';
import { useWalletConnect } from './hooks/useWalletConnect';
import type { Asset } from './lib/types';
import { COINS, DESK, requestQuote, acceptAndSettle, toHuman, type Quote } from './lib/otc';

const CLAY = '#D2683B';

function Monogram({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden>
      <rect x="18" y="20" width="12" height="60" rx="3" fill="#F7F6F2" />
      <rect x="70" y="20" width="12" height="60" rx="3" fill="#F7F6F2" />
      <rect x="31" y="41" width="28" height="7" rx="2" fill={CLAY} />
      <polygon points="58,36 58,53 72,44.5" fill={CLAY} />
      <rect x="41" y="53" width="28" height="7" rx="2" fill={CLAY} />
      <polygon points="42,48 42,65 28,56.5" fill={CLAY} />
    </svg>
  );
}

function Btn({
  children,
  onClick,
  disabled,
  variant = 'primary',
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'ghost';
}) {
  const base =
    'px-5 py-2.5 rounded-xl text-sm font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
  const style =
    variant === 'primary'
      ? 'bg-[#D2683B] hover:bg-[#c15c31] text-white'
      : 'border border-white/15 text-white/80 hover:bg-white/5';
  return (
    <button onClick={onClick} disabled={disabled} className={`${base} ${style}`}>
      {children}
    </button>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 text-center">{children}</div>
  );
}

export default function App() {
  const wallet = useWalletConnect();
  const wf = useMemo(() => ({ query: wallet.query, intent: wallet.intent }), [wallet.query, wallet.intent]);

  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [amount, setAmount] = useState('5');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [stage, setStage] = useState<'idle' | 'quoting' | 'quoted' | 'settling' | 'done'>('idle');
  const [progress, setProgress] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [bal, setBal] = useState<Record<string, string>>({});

  const loadBalances = useCallback(async () => {
    try {
      const assets = await wallet.query<Asset[]>(RPC_METHODS.GET_BALANCE);
      const next: Record<string, string> = {};
      for (const a of assets ?? []) next[a.symbol] = toHuman(a.totalAmount, a.decimals);
      setBal(next);
    } catch {
      /* balance read may be denied — non-fatal */
    }
  }, [wallet]);

  useEffect(() => {
    if (wallet.isConnected) void loadBalances();
  }, [wallet.isConnected, loadBalances]);

  const reset = () => {
    setQuote(null);
    setProgress([]);
    setError(null);
    setStage('idle');
  };

  const onQuote = async () => {
    setError(null);
    setQuote(null);
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) {
      setError('Enter a positive amount.');
      return;
    }
    setStage('quoting');
    try {
      const q = await requestQuote(wf, side, n);
      setQuote(q);
      setStage('quoted');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage('idle');
    }
  };

  const onTrade = async () => {
    if (!quote) return;
    setError(null);
    setStage('settling');
    setProgress([]);
    try {
      await acceptAndSettle(wf, quote, (s) => setProgress((p) => [...p, s]));
      setStage('done');
      void loadBalances();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage('quoted');
    }
  };

  // ---- gates ----
  if (!wallet.isConnected) {
    if (wallet.isAutoConnecting) {
      return (
        <Center>
          <Monogram size={56} />
          <p className="mt-4 text-white/40 text-sm">Connecting your Sphere wallet…</p>
        </Center>
      );
    }
    return (
      <Center>
        <Monogram size={64} />
        <h1 className="mt-5 text-2xl font-bold tracking-wide">HAU OTC DESK</h1>
        <p className="mt-1 text-white/45 text-sm">Autonomous OTC market-maker · atomic escrow settlement</p>
        <div className="mt-7">
          <Btn onClick={wallet.connect} disabled={wallet.isConnecting}>
            {wallet.isConnecting ? 'Connecting…' : 'Connect Sphere wallet'}
          </Btn>
        </div>
        {wallet.error && <p className="mt-4 text-red-400 text-xs max-w-sm text-center">{wallet.error}</p>}
      </Center>
    );
  }

  if (wallet.isWalletLocked) {
    return (
      <Center>
        <Monogram size={56} />
        <p className="mt-4 text-white/70">Wallet locked</p>
        <p className="mt-1 text-white/40 text-sm">Unlock your Sphere wallet to continue.</p>
      </Center>
    );
  }

  const price = quote ? (Number(quote.priceScaled) / 1e8).toString() : '';
  const qtyUct = quote ? toHuman(quote.baseAmount, COINS.UCT.decimals) : '';
  const costUsdu = quote ? toHuman(quote.quoteAmount, COINS.USDU.decimals) : '';
  const ident = wallet.identity?.nametag
    ? '@' + wallet.identity.nametag
    : (wallet.identity?.chainPubkey ?? '').slice(0, 10) + '…';

  return (
    <div className="min-h-screen max-w-3xl mx-auto px-5 py-8">
      <header className="flex items-center gap-3">
        <Monogram size={40} />
        <div>
          <div className="font-bold tracking-wide leading-tight">HAU OTC DESK</div>
          <div className="text-[11px] text-white/40">trading with {DESK} · testnet2</div>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <span className="text-xs text-white/50 font-mono">{ident}</span>
          <Btn variant="ghost" onClick={wallet.disconnect}>Disconnect</Btn>
        </div>
      </header>

      <section className="mt-6 grid grid-cols-2 gap-3">
        {(['UCT', 'USDU'] as const).map((s) => (
          <div key={s} className="rounded-2xl border border-white/8 bg-white/[0.02] p-4">
            <div className="text-[11px] tracking-widest text-white/40">{s} BALANCE</div>
            <div className="mt-1 text-2xl font-bold">
              {bal[s] ?? '—'} <span className="text-sm text-white/40">{s}</span>
            </div>
          </div>
        ))}
      </section>

      <section className="mt-4 rounded-2xl border border-white/8 bg-white/[0.02] p-5">
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-xl border border-white/10 p-0.5">
            {(['buy', 'sell'] as const).map((s) => (
              <button
                key={s}
                onClick={() => { setSide(s); reset(); }}
                className={`px-4 py-1.5 rounded-lg text-sm font-semibold capitalize ${
                  side === s ? 'bg-[#D2683B] text-white' : 'text-white/60'
                }`}
              >
                {s} UCT
              </button>
            ))}
          </div>
          <input
            value={amount}
            onChange={(e) => { setAmount(e.target.value); reset(); }}
            inputMode="decimal"
            className="ml-auto w-32 px-3 py-2 rounded-xl bg-white/[0.03] border border-white/10 text-right font-mono focus:outline-none focus:border-[#D2683B]"
            placeholder="0.0"
          />
          <span className="text-white/40 text-sm">UCT</span>
        </div>

        <div className="mt-4">
          {stage === 'idle' && <Btn onClick={onQuote}>Request quote</Btn>}
          {stage === 'quoting' && <p className="text-white/50 text-sm">Requesting a firm quote from the desk…</p>}

          {quote && stage !== 'quoting' && (
            <div className="rounded-xl border border-[#D2683B]/30 bg-[#D2683B]/[0.06] p-4">
              <div className="text-[11px] tracking-widest text-white/40">FIRM QUOTE</div>
              <div className="mt-1 text-lg font-semibold capitalize">
                {side} {qtyUct} UCT <span className="text-white/40">@</span> {price}{' '}
                <span className="text-white/40">=</span> {costUsdu} USDU
              </div>

              {stage === 'quoted' && (
                <div className="mt-3 flex gap-2">
                  <Btn onClick={onTrade}>Confirm &amp; trade</Btn>
                  <Btn variant="ghost" onClick={reset}>Cancel</Btn>
                </div>
              )}

              {(stage === 'settling' || stage === 'done') && (
                <ol className="mt-3 space-y-1 text-sm">
                  {progress.map((p, i) => (
                    <li key={i} className="text-white/70">
                      <span className="text-[#5FBF8E]">✓</span> {p}
                    </li>
                  ))}
                </ol>
              )}

              {stage === 'done' && (
                <div className="mt-3 flex items-center gap-3">
                  <span className="text-[#5FBF8E] font-semibold">Settled on-chain ✓</span>
                  <Btn variant="ghost" onClick={reset}>New trade</Btn>
                </div>
              )}
            </div>
          )}
        </div>

        {error && <p className="mt-3 text-red-400 text-sm">{error}</p>}
      </section>

      <p className="mt-6 text-center text-[11px] text-white/25">
        Every transfer is a wallet-approved intent. The escrow agent settles both legs atomically or refunds on
        timeout.
      </p>
    </div>
  );
}
