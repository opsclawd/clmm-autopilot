# clmm-autopilot

Solana CLMM “Stop-Loss Autopilot” MVP for protecting a SOL/USDC concentrated liquidity position with a **bidirectional out-of-range exit policy**.

## MVP behavior (Phase 1)

Monitor an Orca Whirlpools LP position (SOL/USDC) and:

- **Break below lower tick** (debounced / wick-filtered):
  1) remove liquidity + collect fees
  2) swap any resulting **SOL exposure → USDC**
- **Break above upper tick** (debounced / wick-filtered):
  1) remove liquidity + collect fees
  2) swap any resulting **USDC exposure → SOL**

Execution must enforce:

- strict slippage caps
- fee buffers
- limited retries
- fail-safe notifications

**Phase 1 ships as:**

- Alerts + **one-click execution** (user signs)
- Minimal Anchor “claim/receipt” program that records a **one-time on-chain execution receipt per epoch** (prevents duplicate claims + provides audit proof)

## Tech stack

- App: **Next.js (latest)** (see `./apps/web`)
- On-chain: Anchor receipt program (to be added)

## Tooling (pinned — do not float)

- Agave/Solana tooling (CLI): **v2.3.0** (`.solana-version`)
- Anchor CLI + crates + TS client: **v0.32.1** (`Anchor.toml`)
- Host Rust toolchain: **Rust 1.93.1** (`rust-toolchain.toml`)
- Node runtime: **Node 22.22.0 LTS** (`.nvmrc`)
- Package manager: **pnpm 10.29.3** (`package.json#packageManager`)

## Getting started

### Web app

```bash
pnpm install
pnpm dev
```

### Solana / Anchor (next phase)

This repo currently includes only the pinned tooling config + the Next.js scaffold.

Planned commands once the Anchor program is added:

```bash
solana --version   # should be 2.3.0
anchor --version   # should be 0.32.1
anchor build
anchor test
```

## Repo layout

- `apps/web/` — Next.js app scaffold
- `Anchor.toml` — Anchor workspace config (pinned version)
- `.solana-version` — Solana/Agave version pin
- `rust-toolchain.toml` — Rust toolchain pin

## Notes / constraints

- Phase 1 is **alert + user-signed execution** (no autonomous key custody).
- Receipt program is intentionally minimal: one receipt per epoch to prevent duplicate execution claims and provide an audit trail.
