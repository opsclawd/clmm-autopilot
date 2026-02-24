# M8 — Pair guardrails (true SOL/USDC) + mint registry

## Goal

Make the MVP truthful and non-footgun by enforcing that the monitored/executed position is exactly SOL/USDC (and not “SOL vs anything”).

## Scope

### In scope

- Canonical mint registry in packages/core:
  - MINTS.sol (native SOL marker)
  - MINTS.usdc per cluster (devnet/mainnet)
  - Optional: allow list per cluster for future expansion (but MVP enforces only SOL/USDC).
- Pair validation:
  - Given a Whirlpool snapshot (pool mints + tickSpacing), assert pair is {SOL, USDC}.
  - If not, fail with canonical error code NOT_SOL_USDC.
- Direction validation:
  - Ensure exit direction maps to swap intent correctly:
    - downside: end in USDC (swap any SOL exposure to USDC)
    - upside: end in SOL (swap any USDC exposure to SOL)
- UI labeling:
  - UI must display token symbols derived from registry (SOL/USDC only).
  - If pair mismatch: block execute button + show explicit reason.

### Out of scope

- Multi-pair support
- Token-2022 edge-case compatibility beyond correct rejection
- Stablecoin variants (USDT/EURC)

## Required deliverables

- packages/core/src/mints.ts:
  - getMintRegistry(cluster)
  - isSolUsdcPair(mintA, mintB, cluster)
  - assertSolUsdcPair(...) -> void | throws normalized error
- packages/solana:
  - Wire pair validation into snapshot loading and into tx build path.
  - Tx build must refuse to build if pair mismatch (fail fast).
- apps/web + apps/mobile:
  - Show explicit pair string and validation status.
  - Disable execute when invalid.

## Tests

### Unit tests (packages/core)

- isSolUsdcPair:
  - passes for SOL/USDC (both mint orderings)
  - fails for SOL/USDT, SOL/jitoSOL, USDC/USDT, random mints
- assertSolUsdcPair returns canonical error code NOT_SOL_USDC.

### Integration tests (packages/solana)

- Snapshot for non-SOL/USDC whirlpool -> fails before any tx build attempt.

## Acceptance criteria (pass/fail)

Pass only if:

1. It is impossible to reach buildExitTransaction with a non-SOL/USDC position.
2. Error surfaced to UI is deterministic and uses canonical taxonomy (NOT_SOL_USDC).
3. Tests cover both mint orderings and negative cases.
