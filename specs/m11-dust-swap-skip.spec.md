# M11 — Dust handling + swap-skip rules (deterministic execution)

## Goal

Prevent fragile failures caused by tiny residual balances (“dust”) and make swap behavior deterministic under minimum thresholds.

## Scope

### In scope

- Define “swap-skip” thresholds in config (from M10):
  - SOL exposure: skip swap if `solLamports < minSolLamportsToSwap`
  - USDC exposure: skip swap if `usdcMinor < minUsdcMinorToSwap`
- Builder behavior:
  - Always remove liquidity + collect fees.
  - Swap step is conditional:
    - If exposure below threshold -> omit Jupiter swap instructions entirely.
    - If omitted, still write receipt (attestation must reflect swap intent and that it was skipped).
- Attestation update:
  - Add `swapPlanned (u8)` + `swapExecuted (u8)` + `swapReasonCode (u16)` into attestation payload.
  - `swapExecuted=0` when skipped due to dust.
  - Ensure hashing remains deterministic with new fields.
- UI:
  - Must show whether swap will be executed or skipped before user signs.

### Out of scope

- Partial swaps
- Multi-hop route selection logic beyond Jupiter canonical
- Automatic “top-up” of exposure to meet thresholds

## Required deliverables

- packages/core:
  - swap decision helper:
    - `decideSwap(exposure, direction, config) -> { execute: boolean, reasonCode }`
- packages/solana:
  - Builder uses `decideSwap` and conditionally appends swap ixs.
  - If swap skipped, ensure WSOL lifecycle instructions are not inserted unnecessarily.
- Apps:
  - Display swap decision.

## Tests

### Unit tests (packages/core)

- `decideSwap`:
  - below threshold -> skip, reasonCode set
  - above threshold -> execute

### Integration tests (packages/solana)

- Build tx with dust SOL exposure:
  - no Jupiter instructions
  - receipt still present
  - attestation hash differs from “swap executed” case
- Build tx with dust USDC exposure similarly.

## Acceptance criteria (pass/fail)

Pass only if:

1. Dust never causes a Jupiter route build or swap failure.
2. The presence/absence of swap instructions is fully determined by config thresholds.
3. Receipt attests to whether swap executed or was skipped and why.
