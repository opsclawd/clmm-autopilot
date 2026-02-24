# M12 — Devnet end-to-end harness + operator runbook

## Goal

Prove the MVP works end-to-end on devnet with a repeatable, scriptable harness and a concrete operator runbook for failure triage.

## Scope

### In scope

- E2E harness in `apps/web` or `packages/solana` (choose one place; not duplicated):
  - Given:
    - RPC URL
    - authority keypair (dev only)
    - position address
  - Steps:
    1) fetch snapshot
    2) evaluate decision with policy engine
    3) if trigger, fetch quote, compute attestation, build tx
    4) simulate
    5) send + confirm
    6) verify receipt account exists for epoch
- Deterministic fixtures:
  - store one known devnet position address in a `.env.example` (not secrets).
  - allow overriding via env.
- Runbook (`docs/runbook.md`):
  - How to run web + mobile
  - How to run harness
  - Failure modes mapped to actions:
    - stale quote
    - moved price / rebuild required
    - blockhash expired
    - insufficient fee buffer
    - already executed this epoch
    - swap skipped due to dust
- CI:
  - Do not require devnet in CI.
  - Add a “manual” GitHub Actions workflow that can run devnet harness with secrets (optional), but keep MVP valid without it.

### Out of scope

- Mainnet automation
- Background execution
- Push notification infra

## Required deliverables

- Harness command:
  - `pnpm e2e:devnet` (or similar) prints structured logs and exits non-zero on failure.
- Receipt verification:
  - read receipt PDA and assert fields match:
    - authority
    - position_mint
    - epoch
    - direction
    - stored hash == computed attestation hash
- Docs:
  - `docs/runbook.md`
  - `docs/e2e-devnet.md` (optional, but recommended)

## Tests

- Minimal “fake RPC” unit tests for harness sequencing:
  - ensure it refuses to proceed when `NOT_SOL_USDC` or `ALREADY_EXECUTED_THIS_EPOCH`
- Localnet tests are acceptable for receipt verification if devnet harness is not run in CI.

## Acceptance criteria (pass/fail)

Pass only if:

1. A single command can execute the full path and prove receipt correctness.
2. Runbook exists and is specific (commands, files, error-action mapping).
3. The attestation hash verified from on-chain receipt matches the locally computed hash.
