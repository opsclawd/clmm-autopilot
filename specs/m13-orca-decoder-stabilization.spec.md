# M13 — Orca decoding stabilization (remove brittle offsets)

## Goal

Eliminate buffer-offset parsing for Whirlpool/Position/TickArray decoding in runtime paths to reduce “random” breakage.

## Scope

### In scope

- Replace any fixed-offset slicing of account data used in the live code path with one of:
  - official Orca Whirlpool SDK decoders, or
  - Anchor/IDL-based layouts if appropriate, or
  - a single centralized Borsh layout module with versioned structs.
- Keep offset parsing only in tests (if needed) and behind `__tests__/` utilities.

### Out of scope

- Supporting multiple Whirlpool program versions
- Custom fork compatibility

## Required deliverables

- `packages/solana/src/orca/decode.ts`:
  - `decodeWhirlpoolAccount(data)`
  - `decodePositionAccount(data)`
  - `decodeTickArrayAccount(data)`
- Inspector uses these decoders exclusively.
- If decoder fails, error must be normalized with canonical reason code `ORCA_DECODE_FAILED`.

## Tests

- Unit tests:
  - decode success for captured fixtures (store minimal base64 fixtures in repo)
  - decode failure yields `ORCA_DECODE_FAILED`
- Integration:
  - inspector uses decoder module; no direct slicing in inspector file.

## Acceptance criteria (pass/fail)

Pass only if:

1. No runtime code depends on magic byte offsets for Orca accounts.
2. Failures are explicit and normalized.
3. Fixtures prove decode stability for known account samples.
