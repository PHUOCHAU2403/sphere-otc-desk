# Brand assets — Hau OTC Desk

Minimal, geometric identity (Bauhaus / editorial-luxury). Two marks:

- **Primary — monogram H** (`logo-icon-h.*`, `logo-mark-h.svg`): the letter H
  (Hau) whose two pillars are the counterparties and whose crossbar is a two-way
  swap. Use for the project avatar / app icon.
- **Secondary — swap arrows** (`logo-icon.*`, `logo-mark.svg`): two opposing
  arrows (⇄) — the atomic two-way exchange. Use as a favicon / compact mark where
  the monogram is too detailed.

## Palette

| Role | Hex |
|---|---|
| Ink (dark field / structure) | `#111113` |
| Paper (light field / pillars) | `#F7F6F2` |
| Clay (accent — the swap) | `#D2683B` |

Clay bridges the Anthropic-clay and Sphere-orange palettes, so the mark also sits
cleanly on the portal's orange (`#F26B21`) — see `logo-icon-*` variants.

## Files

| File | Use |
|---|---|
| `logo-icon-h.svg` / `-512.png` / `-256.png` | **Primary avatar** (monogram on ink) |
| `logo-mark-h.svg` | Monogram mark only (transparent) |
| `logo-icon.svg` / `-512.png` / `-256.png` | Secondary icon (arrows on ink) |
| `logo-mark.svg` | Arrows mark only (transparent) |
| `logo-icon-paper.svg` / `-512.png` | Light-background icon |
| `logo-wordmark.svg` / `.png` | Horizontal lockup (headers, README) |
| `cover.svg` / `cover.png` | 1280×640 cover / social preview |

SVG is the master; PNGs are rendered from it. Regenerate with any SVG→PNG tool.
