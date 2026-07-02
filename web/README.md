# Hau OTC Desk — web terminal (Sphere Connect dApp)

A browser dApp that lets a user connect their **Sphere wallet** and trade with the
autonomous OTC desk. The connected user is the *taker*: they request a firm quote
from `@hau-otc-desk` and settle through `@hau-escrow` — the same wire protocol the
CLI taker speaks, but every money-moving step is a **wallet-approved Connect intent**
(`dm`, `send`). The dApp holds no keys and never touches the network directly; the
wallet does, via the Sphere Connect RPC.

## How it maps to the acceptance criteria

- **Sphere Connect + autoConnect** — `useWalletConnect` (from the official example):
  P1 iframe (`PostMessageTransport`) / P2 extension / P3 popup, silent auto-connect.
- **Intents** — `dm` (RFQ + accept) and `send` with `memo` (deposit the leg to the
  escrow). No direct signing/transfer outside intents.
- **Events** — reacts to `wallet:locked` (locked overlay) and `identity:changed`.
- **Least privilege** — only the scopes the flow needs (read balance/resolve/messages,
  `dm`, `send`).

## Run locally

```bash
cd web
npm install
npm run dev        # http://localhost:5174 — needs a Sphere wallet + the desk/escrow online
```

The desk (`npm run live`) and escrow (`npm run escrow`) agents must be running (see the
repo root) so the wallet's DMs/transfers reach them.

## Deploy

Pushed to `main`, `.github/workflows/deploy-web.yml` builds this folder and publishes it
to GitHub Pages (`VITE_BASE_PATH=/sphere-otc-desk/`). Enable Pages → Source: GitHub Actions.
The resulting App URL loads inside Sphere's iframe.

## Layout

- `src/hooks/useWalletConnect.ts` — Sphere Connect plumbing (reused from the example).
- `src/lib/otc.ts` — coin registry, wire protocol, and the RFQ → quote → accept → settle flow.
- `src/App.tsx` — the OTC terminal UI.
