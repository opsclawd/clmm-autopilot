# M5 — Execution builder

## Goal

Build the unsigned “one-click execute” transaction that closes the position, converts exposure, and writes the receipt in the same transaction with strict guardrails.

## Scope

### In scope

- `packages/solana` implements:
  - `buildExitTransaction(snapshot, direction, config) -> VersionedTransaction | TransactionMessage`
- Transaction contains, in order:
  1) compute budget (if used)
  2) remove liquidity
  3) collect fees
  4) swap exposure to target side:
     - downside: SOL -> USDC
     - upside: USDC -> SOL
  5) record receipt (`record_execution`) in the same tx
- Safety rules:
  - strict slippage cap (bps) enforced on swap minOut
  - fee buffer enforced (abort if expected fees insufficient)
  - simulate required; abort on simulation error
  - bounded retries for quote refresh only (no blind resend loops)
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
  - validates receipt ix appended
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
