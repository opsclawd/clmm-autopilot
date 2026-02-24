# M9 — Execution attestation hash (receipt integrity)

## Goal

Make the on-chain receipt meaningful: it must cryptographically attest to the exact execution intent and inputs, not a placeholder value.

## Scope

### In scope

- Canonical attestation payload definition in packages/core:
  - A deterministic byte encoding for:
    - cluster (u8)
    - authority pubkey (32)
    - position pubkey (32)
    - position mint pubkey (32)
    - whirlpool pubkey (32)
    - epoch unixDays (u32 LE)
    - direction (u8: 0=DOWN, 1=UP)
    - snapshot tickCurrent (i32 LE)
    - lowerTickIndex (i32 LE)
    - upperTickIndex (i32 LE)
    - slippageBpsCap (u16 LE)
    - quote:
      - inputMint (32)
      - outputMint (32)
      - inAmount (u64 LE)
      - minOutAmount (u64 LE)
      - quotedAtUnixMs (u64 LE)
- Hashing:
  - attestationHash = sha256(attestationPayloadBytes) producing [u8; 32].
- Receipt program interface:
  - Continue storing tx_sig_hash as [u8; 32], but redefine Phase-1 meaning:
    - tx_sig_hash MUST be attestationHash (not tx signature hash).
  - Program name and account layout unchanged; only semantic change.
- UI:
  - Must compute attestation hash and pass it into the tx builder (no zeros).
  - Display a short prefix of hash in “Ready to execute” view (debug only).

### Out of scope

- Merkle proofs / multi-action receipts
- Signing the attestation off-chain
- Additional oracle prices beyond the tick snapshot

## Required deliverables

- packages/core/src/attestation.ts:
  - encodeAttestationPayload(input) -> Uint8Array
  - hashAttestationPayload(bytes) -> Uint8Array(32)
  - computeAttestationHash(input) -> Uint8Array(32)
- packages/solana:
  - buildExitTransaction(..., config) must require attestationHash present.
  - Fail fast with MISSING_ATTESTATION_HASH if absent.
  - Wire receipt instruction to use attestationHash.
- apps/web + apps/mobile:
  - Compute hash from the same snapshot/quote/config used to build the tx.
  - Prevent execute if hash cannot be computed.

## Tests

### Unit tests (packages/core)

- Encoding determinism:
  - same input -> identical bytes -> identical hash
  - any single field change -> different hash
- Golden vector tests:
  - hardcode one sample input and expected hex hash.

### Integration tests (packages/solana)

- Build path refuses new Uint8Array(32) only if it was not computed by helper:
  - enforce “computed” by requiring caller pass structured input OR by validating payload presence alongside hash.
- Receipt ix data includes passed hash exactly.

## Acceptance criteria (pass/fail)

Pass only if:

1. The receipt stores a non-zero sha256 derived from canonical payload bytes.
2. Hash is deterministic across runs and independent of object key ordering.
3. Tests include golden vectors and mutation checks.
