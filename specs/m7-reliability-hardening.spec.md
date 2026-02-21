# M7 — Reliability hardening

## Goal

Harden execution reliability in fast markets and common RPC failure modes without unsafe behavior.

## Scope

### In scope

- Quote freshness and rebuild logic:
  - if tick/price moved beyond threshold since quote, rebuild tx
- Blockhash management:
  - refresh on user delay; rebuild message before send if needed
- Idempotency checks:
  - check for existing receipt before building tx (using canonical epoch definition from `SPEC.md`)
- Bounded retries:
  - RPC fetch retry (bounded, backoff)
  - quote retry (bounded)
  - no infinite resend; no adaptive slippage widening
- Observability:
  - structured logs with reason codes
  - error normalization surfaced to UI using canonical taxonomy from `SPEC.md`

### Out of scope

- Background bots
- Delegated signing/session keys
- MEV/priority fee optimization beyond basic compute budget/fees

## Required deliverables

- Reliability module in `packages/solana` with:
  - `shouldRebuild(quote, latestSnapshot, config)`
  - `refreshBlockhashIfNeeded`
  - normalized error taxonomy
- Tests:
  - stale quote triggers rebuild
  - blockhash expiry triggers rebuild
  - transient RPC failures retry and then fail cleanly
  - receipt exists -> abort build with `ALREADY_EXECUTED_THIS_EPOCH`

## Acceptance criteria (pass/fail)

Pass only if:

1. All reliability behaviors are deterministic and tested.
2. No safety regressions: slippage remains hard-capped; no widening.
3. UI surfaces explicit failure reasons and does not “retry blindly.”

## Definition of Done

- System fails safe, rebuilds only when justified, and remains auditably idempotent.
