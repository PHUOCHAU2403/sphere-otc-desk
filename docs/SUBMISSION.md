# Submission — Hau OTC Desk

**Autonomous OTC market-maker agent on the Unicity AgentSphere.** It posts a
market intent, quotes inbound RFQs deterministically over encrypted DMs, haggles
within a reservation band, and settles trades as atomic swaps through a dedicated
escrow agent. A companion taker agent and the escrow agent drive the full loop
end to end — two agents negotiate and settle a trade with no human clicking
through any step.

| | |
|---|---|
| **Build track** | Autonomous Agents (also fits Payments + Markets) |
| **Agentic** | **Yes** — see "Autonomy" below |
| **AstridOS** | No (bare Sphere SDK on Node) |
| **Network** | Unicity **testnet2** (`SPHERE_NETWORK=testnet`) |
| **Repository (public)** | https://github.com/PHUOCHAU2403/sphere-otc-desk |
| **Live agents** | desk `@hau-otc-desk` · taker `@hau-taker` · escrow `@hau-escrow` |

## What it is

An over-the-counter (OTC) desk is a market maker that quotes a private, two-way
price and trades directly with a counterparty — no public order book to
front-run. This is exactly what the AgentSphere enables for machines: discover
each other on the network, negotiate privately, and settle atomically.

`Hau OTC Desk` makes a two-way market in **UCT/USDU**. When another agent sends an
RFQ, the desk prices it from a reference mid ± spread, replies with a firm quote,
honours a counter down to its reservation price, and — on accept — opens an
atomic swap. The bundled **taker** (`npm run taker -- buy 5 --accept`) is a second
agent that requests a quote and completes the deal, demonstrating a real
agent-to-agent trade.

## How it uses the Sphere SDK (depth)

Network primitives exercised — not a wallet bolted on the surface:

- **Identity & nametags** — the desk registers `@hau-otc-desk`; the taker
  resolves it and addresses it by nametag.
- **Messaging (encrypted DMs)** — the entire RFQ ⇄ quote ⇄ counter ⇄ accept
  negotiation runs over `communications.sendDM` / `onDirectMessage`, with a
  small JSON wire protocol so agents (not humans) speak it.
- **Market intent** — the desk advertises itself on the bulletin board via
  `market.postIntent`, so other agents can discover and RFQ it.
- **Payments & minting** — real testnet UCT inventory received via the wallet-api
  mailbox; the taker funds itself with `payments.mintFungibleToken` (USDU).
- **Escrow-mediated atomic settlement** — a **third agent** (`@hau-escrow`,
  `npm run escrow`) holds both legs and pays them out crossed only when both
  arrive, refunding a lone leg on timeout. On accept, the desk registers the
  swap with the escrow, tells the taker to pay its leg, and deposits its own —
  all as memo-tagged wallet-api transfers. Atomic from each party's view: both
  complete, or both keep their tokens. (We ship our own escrow because the v2
  testnet escrow isn't migrated yet — confirmed by the Unicity team, who
  suggested exactly this.)

## Autonomy

Agentic by the campaign's definition: the desk **initiates and completes economic
actions on its own**. It decides *when* to quote (on each inbound RFQ), *how* to
price (deterministic engine, never an LLM), whether to accept a counter, when to
reserve inventory, and when to open and settle the swap — programmatically, as a
running service. A human only sets goals and limits (pair, spread, size caps,
loss limit). No step requires a person to click send.

## Usefulness

Solves a real problem for the agent economy: illiquid, fragmented, or
relationship-based trades that don't fit a public order book. An always-on OTC
desk gives counterparty agents a private, firm quote and atomic settlement —
the natural primitive for agent-to-agent value exchange.

## Completeness & craft

- **Pure domain core** (pricing, negotiation, risk) fully decoupled from the SDK,
  unit-tested with a deterministic offline suite — 8 runnable checks
  (`sim`, `acceptorcheck`, `safetycheck`, `pnlcheck`, `prelockcheck`,
  `hardeningcheck`, `persistcheck`, `pricecheck`), all green.
- **Risk stack** (real, not decorative): deterministic quoting, inventory +
  per-counterparty + exposure limits, manual kill-switch, consecutive-failure
  circuit breaker, daily mark-to-market P&L breaker, pre-lock counterparty check.
- **Operational maturity**: crash-safe persistence with boot-time reconciliation,
  chain↔ledger true-up, **tamper-evident hash-chained audit log**, and a
  Grafana-style **ops dashboard** generated from live state.
- Clear README with run instructions, strict TypeScript, sensible structure.

## Contribution to the network

The desk **exposes a service other agents can transact with**: it publishes a
market intent and answers RFQs, so any agent that speaks the wire protocol can
get a firm quote and trade. The **reusable escrow agent** is itself a
contribution — any two agents can settle an atomic swap through it while the
native `sphere.swap` escrow is still being migrated to v2. The repo also
documents the native swap model (`docs/SETTLEMENT-MODEL.md`) and the v2 setup
gotchas we hit (wallet-api rails, network forwarding, the `ws` WebSocket) —
useful for other builders.

## Run / reproduce (testnet2)

```bash
npm install
cp .env.example .env       # set DESK_NAMETAG, ORACLE_API_KEY (public testnet2 key)

npm run escrow             # 1) escrow agent (@hau-escrow): holds + settles both legs
npm run live               # 2) desk: registers nametag, posts intent, listens for RFQs
# in another terminal:
npm run mint  -- USDU 100  # fund the taker wallet (no faucet on v2)
npm run taker -- buy 5     # taker RFQs the desk → receives a firm quote (Chặng A)
npm run taker -- buy 5 --accept   # full loop: quote → accept → escrow settles (Chặng B)

npm run dashboard          # render the live ops dashboard (HTML)
# offline: npm run sim && npm run safetycheck && npm run pnlcheck
```

## Status note (honest)

The desk is live on testnet2 and the **full loop settles end to end**: mint →
RFQ → quote → accept → both legs deposited to our escrow agent → escrow pays out
crossed → `escrow_settled`, moving real testnet value in both directions.

We run our **own escrow agent** (`@hau-escrow`) because the protocol's v2 testnet
escrow hasn't been migrated yet — the docs' `@escrow-testnet` returns
`SWAP_RESOLVE_FAILED`, which the Unicity team confirmed is an oversight on their
side and suggested we implement our own for now. Our escrow is a genuine neutral
coordinator: it never nets a token (pays out exactly what it receives), settles
only when both legs are present, and refunds on timeout — so it's atomic from
each party's perspective (the two counterparties never have to trust *each
other*; they rely on the escrow agent to follow its rules for the few seconds it
holds both legs). This is escrow-based, not the trustless non-custodial model —
honest framing. When the native predicate-based escrow ships on v2, the desk can
swap back to `sphere.swap` with no change to the negotiation or risk layers.
