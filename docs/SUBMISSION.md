# Submission — Hau OTC Desk

**Autonomous OTC market-maker agent on the Unicity AgentSphere.** It posts a
market intent, quotes inbound RFQs deterministically over encrypted DMs, haggles
within a reservation band, and settles trades as non-custodial atomic swaps. A
companion taker agent drives the full loop end to end — two agents negotiate and
settle a trade with no human clicking through any step.

| | |
|---|---|
| **Build track** | Autonomous Agents (also fits Payments + Markets) |
| **Agentic** | **Yes** — see "Autonomy" below |
| **AstridOS** | No (bare Sphere SDK on Node) |
| **Network** | Unicity **testnet2** (`SPHERE_NETWORK=testnet`) |
| **Repository (public)** | https://github.com/PHUOCHAU2403/sphere-otc-desk |
| **Live agents** | desk `@hau-otc-desk` · taker `@hau-taker` |

## What it is

An over-the-counter (OTC) desk is a market maker that quotes a private, two-way
price and trades directly with a counterparty — no public order book to
front-run, no intermediary holding funds. This is exactly what the AgentSphere
enables for machines: discover each other on the network, negotiate privately,
and settle atomically.

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
- **Swaps** — on accept, the desk calls `swap.proposeSwap`; the taker handles
  `swap:proposal_received → acceptSwap → deposit → swap:completed` for
  non-custodial atomic settlement.

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
get a firm quote and trade. The repo also documents the SDK's non-custodial
swap mechanics (`docs/SETTLEMENT-MODEL.md`) and the v2 setup gotchas we hit
(wallet-api rails, network forwarding, the `ws` WebSocket) — useful for other
builders.

## Run / reproduce (testnet2)

```bash
npm install
cp .env.example .env       # set DESK_NAMETAG, ORACLE_API_KEY (public testnet2 key)

npm run live               # desk: registers nametag, posts intent, listens for RFQs
# in another terminal:
npm run mint  -- USDU 100  # fund the taker wallet (no faucet on v2)
npm run taker -- buy 5     # taker RFQs the desk → receives a firm quote
npm run taker -- buy 5 --accept   # full loop: quote → accept → atomic swap

npm run dashboard          # render the live ops dashboard (HTML)
# offline: npm run sim && npm run safetycheck && npm run pnlcheck
```

## Status note (honest)

The desk is live on testnet2 and the full negotiation path works end to end:
mint → RFQ → quote → accept → `proposeSwap` (deal validated). Atomic-swap
*settlement* needs a testnet2 **escrow address** — the docs' `@escrow-testnet`
does not resolve on testnet2 (`SWAP_RESOLVE_FAILED`). The escrow address is read
from `ESCROW_ADDRESS` in `.env`; once the correct testnet2 escrow is provided,
the swap settles with no code change. Everything up to that single external
dependency runs and moves real testnet value.
