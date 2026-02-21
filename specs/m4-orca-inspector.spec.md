# M4 — Orca inspector

## Goal

Build a read-only position inspector for Orca Whirlpools that returns a stable snapshot used by policy + UI.

## Scope

### In scope

- `packages/solana` implements:
  - `loadPositionSnapshot(connection, positionPubkey) -> Snapshot`
- Snapshot includes:
  - whirlpool address
  - current tick index
  - lower/upper ticks
  - tick spacing
  - liquidity
  - token mints + decimals
  - best-effort “remove preview” amounts (if available via SDK quote)

### Out of scope

- remove liquidity execution
- swaps
- receipt recording in the same tx

## Constraints

- Must fetch tick arrays required to interpret the position.
- Must fail safely:
  - return typed error codes from canonical taxonomy in `SPEC.md`; never throw raw SDK errors upward unhandled
- Must not use float UI price for “in-range” logic; tick-only.

## Required deliverables

- Orca SDK wiring and account fetches
- Integration tests:
  - fixture-based tests (preferred) OR local validator with seeded accounts
  - validates that snapshot fields are populated and stable
- `apps/web` and `apps/mobile` can display snapshot fields (minimal)

## Acceptance criteria (pass/fail)

Pass only if:

1. Snapshot function works against at least one real devnet position OR a deterministic fixture.
2. `inRange` computed by tick-only comparisons.
3. Errors are normalized and reason-coded.

## Definition of Done

- Inspector returns stable snapshot sufficient for M5 builder + M6 UX.
