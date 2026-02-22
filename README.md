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
- On-chain: Anchor receipt program (`./programs/receipt`)

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

### Solana / Anchor

Preflight + test commands:

```bash
pnpm check:anchor-tooling
solana --version             # should include 2.3.0
solana-test-validator --version  # should include 2.3.0
anchor --version             # should include 0.32.1
anchor build
anchor test
```

If `anchor test` fails with missing binaries, install Solana CLI/Agave and ensure both `solana` and `solana-test-validator` are on your PATH.

## Repo layout

- `apps/web/` — Next.js app scaffold
- `Anchor.toml` — Anchor workspace config (pinned version)
- `.solana-version` — Solana/Agave version pin
- `rust-toolchain.toml` — Rust toolchain pin

## Notes / constraints

- Phase 1 is **alert + user-signed execution** (no autonomous key custody).
- Receipt program is intentionally minimal: one receipt per epoch to prevent duplicate execution claims and provide an audit trail.
