# M2 — Receipt program

## Goal

Implement the Anchor receipt program that records a one-time execution receipt per epoch and prevents duplicate execution for a given position/authority/epoch.

## Scope

### In scope

- Anchor program: `programs/receipt`
- One instruction: `record_execution(epoch, direction, position_mint, tx_sig_hash)`
  - `epoch` uses canonical SPEC definition: `unixDays = floor(unixTs / 86400)`
  - `direction` uses canonical encoding: `u8` (`0=DOWN`, `1=UP`)
- Receipt PDA derived from:
  - seeds: `["receipt", authority, position_mint, epoch_le_bytes]`
- Stored receipt fields:
  - authority, position_mint, epoch, direction, tx_sig_hash, slot and/or unix_ts
  - fixed-size layout only (no dynamic strings)
- `tx_sig_hash` definition:
  - `sha256(tx_signature_bytes)` stored as `[u8; 32]` (canonical for Phase 1)

### Out of scope

- Any CLMM close/swap logic on-chain
- CPI into Orca/Raydium
- Any auto-execution

## Constraints

- Receipt creation must be idempotent by PDA uniqueness (second call must fail deterministically with a stable Anchor error code).
- Authority invariant: stored `authority` must equal the transaction signer; reject otherwise.
- Receipt must be writable only by the signing authority.
- Keep compute minimal; no dynamic allocations beyond account init.
- Account size must be explicitly calculated and fixed at initialization (no realloc).
- Receipt close behavior for Phase 1: **no close instruction** (receipt is append-only audit evidence).

## Required deliverables

- Program code implementing PDA receipt + instruction.
- Anchor tests:
  - creates receipt once
  - second call with same `(authority, position_mint, epoch)` fails
  - different epoch succeeds
  - wrong signer fails
  - receipt data correctness asserted
- TS client artifacts:
  - IDL committed/available
  - `packages/solana` exposes helper to derive receipt PDA + build `record_execution` ix

## Acceptance criteria (pass/fail)

Pass only if:

1. `anchor test` passes with all invariants above.
2. Receipt PDA derivation is canonical and mirrored in TS helper.
3. No additional program instructions added beyond what spec lists.

## Definition of Done

- Receipt program and tests prove one-write-per-epoch per position/authority.
