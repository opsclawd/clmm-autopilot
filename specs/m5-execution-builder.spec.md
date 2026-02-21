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

### Out of scope

- Auto-execution/bot signer
- Background monitoring
- Adaptive slippage widening

## Required deliverables

- Builder code + config types:
