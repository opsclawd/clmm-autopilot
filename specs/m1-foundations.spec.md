# M1 — Foundations

## Goal

Convert scaffolding into a stable base with enforced package boundaries, a real unit test harness, and a reproducible Mobile Wallet Adapter (MWA) signing smoke test.

## Scope

### In scope

- `packages/core`
  - Real unit test harness (Vitest or Jest) with non-trivial tests
  - Enforced constraint: no Solana SDK / RPC / web3 imports
- `packages/solana`
  - Typed config + RPC client wrapper (read-only utilities)
  - Error normalization layer using canonical error taxonomy
  - Integration test harness wired (fixtures or local validator)
- `apps/mobile`
  - MWA integrated
  - “Sign message” OR “sign + send noop tx” smoke flow on devnet (documented)
- `apps/web`
  - Minimal dev console to invoke shared packages (no business logic)

### Out of scope

- Receipt program logic (beyond scaffold)
- Orca Whirlpools integration
- Policy engine implementation (beyond simple test scaffolding)

## Architecture boundary enforcement

Must comply with `docs/architecture.md`.
Hard rule:

- `packages/core` must not import:
  - `@solana/web3.js`
  - any Orca/Raydium/Kamino SDK
  - any RPC client libs

CI must fail if violated.

Additional dependency direction rule:
- `packages/core` must not depend on `packages/solana`.

## Required deliverables

- Boundary gates:
  - ESLint rule, dep-cruiser, or TS path restriction that fails CI on forbidden imports in `packages/core`
  - Dependency-direction gate that fails CI if `packages/core` imports or depends on `packages/solana`
- Tests:
  - `packages/core` has at least 10 meaningful assertions across ≥2 test cases
- Mobile runbook:
  - `docs/runbooks/mobile-mwa.md` with exact commands to run on Android emulator/device
- Root scripts:
  - `pnpm -r test` runs core tests
  - `pnpm --filter @clmm-autopilot/mobile smoke:mwa` runs mobile smoke in dev mode (CI can skip interactive signing)

## Acceptance criteria (pass/fail)

Pass only if:

1. `pnpm -r lint`, `pnpm -r typecheck`, `pnpm -r test` succeed.
2. CI fails if `packages/core` imports Solana SDKs (prove via a temporary import in a local check; do not commit that import).
3. Mobile app builds and launches; MWA sign flow works in devnet runbook.
4. No Orca/Raydium logic or receipt logic implemented.

## Definition of Done

- Boundary enforcement is automated and active in CI.
- Mobile signing smoke test is reproducible via runbook.
