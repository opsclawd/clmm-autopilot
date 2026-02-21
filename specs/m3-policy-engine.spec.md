# M3 — Policy engine

## Goal

Implement the stop-loss trigger decision logic as a pure TS state machine in `packages/core` with exhaustive unit tests.

## Scope

### In scope

- `packages/core` exports:
  - `evaluateRangeBreak(samples, bounds, config) -> decision`
  - decision includes `reasonCode` + debug payload (`samplesUsed`, `threshold`, `cooldownRemainingMs`)
- Decisions:
  - `HOLD`
  - `TRIGGER_DOWN`
  - `TRIGGER_UP`
- Debounce logic (single authoritative rule):
  - consecutive out-of-range sample count using SPEC cadence/threshold (primary rule)
  - optional time-window values must be derived from `requiredConsecutive * cadenceMs` (not a separate trigger rule)
- Cooldown logic:
  - suppress retriggers for configured cooldown after a trigger

### Out of scope

- RPC reads
- Orca SDK use
- Transaction building

## Sampling source

Must match SPEC: current tick samples `(slot, unixTs, currentTickIndex)` compared to lower/upper ticks strictly.

Handling requirements:
- Missing/undecodable tick data returns `HOLD` with `DATA_UNAVAILABLE`.
- Non-monotonic slot/timestamp or sampling gaps must be handled deterministically.
- Duplicate samples must not produce duplicate trigger outputs.

## Required deliverables

- Types:
  - `Sample`, `Bounds`, `Config`, `Decision`, `ReasonCode`
- Tests (minimum):
  - wick below lower then re-enters within window -> `HOLD`
  - sustained below lower -> `TRIGGER_DOWN`
  - wick above upper then re-enters -> `HOLD`
  - sustained above upper -> `TRIGGER_UP`
  - cooldown blocks subsequent triggers
  - missing data returns `HOLD` with `DATA_UNAVAILABLE`
- Property-style invariants:
  - never outputs both triggers for same evaluation
  - deterministic for same input

## Acceptance criteria (pass/fail)

Pass only if:

1. All tests pass in CI.
2. No Solana SDK imports exist in `packages/core`.
3. Behavior matches SPEC debounce + cooldown definitions exactly.

## Definition of Done

- Policy engine is deterministic, unit-tested, and integration-ready.
