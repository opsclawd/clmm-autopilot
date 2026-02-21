# M5 — Execution builder

## Goal

Build the unsigned “one-click execute” transaction that closes the position, converts exposure, and writes the receipt in the same transaction with strict guardrails.

## Scope

### In scope

- `packages/solana` implements:
  - `buildExitTransaction(snapshot, direction, config) -> VersionedTransaction | TransactionMessage`
- Swap routing (Phase 1 canonical):
  - Jupiter quote/swap path (single canonical router)
- SOL handling (Phase 1 canonical):
  - WSOL ATA create/sync/close lifecycle managed in builder when SOL-side swap is required
- Transaction contains, in order:
  1) compute budget (if used)
  2) conditional ATA create instructions (only when required)
  3) remove liquidity
  4) collect fees
  5) swap exposure to target side:
     - downside: SOL -> USDC
     - upside: USDC -> SOL
  6) record receipt (`record_execution`) in the same tx (must be final instruction)
- Safety rules:
  - strict slippage cap (bps) enforced on swap minOut
  - fee buffer enforced (abort if expected fees + rent + priority fee + ATA create costs exceed available balance minus `feeBufferLamports`)
  - simulate required; abort on simulation error
  - simulation success contract: `err == null` and all required instruction accounts resolve; no bypass in UI path
  - bounded retries for quote refresh only (no blind resend loops)
  - retries occur only **before** user signs; each retry must refetch snapshot + quote and rebuild minOut
  - hard cap on total rebuild window: 15s
  - errors normalized to canonical taxonomy from `SPEC.md`
- Receipt idempotency semantics reference canonical epoch definition from `SPEC.md`.

### Out of scope

- Auto-execution/bot signer
- Background monitoring
- Adaptive slippage widening

## Required deliverables

- Builder code + config types:
  - slippage bps cap
  - fee buffer (lamports)
  - max rebuild attempts
  - quote freshness threshold (slot or time)
- Integration tests:
  - validates instruction ordering
  - validates receipt ix appended as final instruction
  - validates that receipt ix uses the canonical epoch definition from M2/SPEC
  - validates that too-tight slippage aborts
  - validates rebuild-on-stale-quote path (deterministic)
- “simulate then send exact message” enforcement documented and implemented

## Acceptance criteria (pass/fail)

Pass only if:

1. Builder produces a deterministic tx plan for a fixed snapshot+quote.
2. Receipt ix is in the same tx.
3. Simulation gate is mandatory and cannot be bypassed in UI path.
4. Tight slippage produces safe abort, not retries into worse pricing.

## Definition of Done

- Unsigned tx builder with guardrails + tests ready for UI wiring.
