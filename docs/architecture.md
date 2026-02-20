# Architecture (monorepo boundaries)

This repo is a monorepo. The boundaries are intentional — do not blur them.

## Top-level layout

- `apps/web` — Next.js shell (UI + wiring only)
- `apps/mobile` — Expo React Native shell + MWA target (UI + wiring only)
- `packages/core` — **pure TypeScript only** (no Solana RPC, no UI)
- `packages/solana` — Solana-specific instruction building + RPC boundaries
- `programs/` — Anchor programs (on-chain)

## Boundary rules (hard)

### `packages/core`

- Pure TS utilities and domain logic.
- No `@solana/web3.js`, no RPC calls, no UI frameworks.

### `packages/solana`

- Builds instructions and transactions.
- Owns RPC boundary (fetching accounts, submitting tx, simulation helpers).
- Must not depend on UI frameworks.

### `apps/web` and `apps/mobile`

- Shells only: routing, state, rendering, wallet adapter wiring.
- Should call into `packages/core` and `packages/solana`.
- Avoid duplicating business logic in apps.

## Why this matters

- Keeps execution safety logic testable in isolation.
- Prevents UI churn from breaking transaction logic.
- Makes it possible to share logic between Web + Mobile from day 1.
