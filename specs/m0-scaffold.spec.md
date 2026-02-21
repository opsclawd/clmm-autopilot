# M0 — Repo scaffold + deterministic gates

## Goal

Establish a reproducible pnpm + turbo monorepo with web and mobile shells, shared packages, an Anchor workspace, and CI gates that prevent drift.

## Scope

### In scope

- Repository structure:
  - `apps/web` (Next.js boot)
  - `apps/mobile` (Expo RN boot)
  - `packages/core` (pure TS, no Solana deps)
  - `packages/solana` (may be stubbed)
  - `programs/receipt` (Anchor scaffold only)
- Toolchain pins committed to repo:
  - Solana/Agave CLI v2.3.0
  - Anchor v0.32.1
  - Rust toolchain 1.93.1
  - Node 22.22.0
  - pnpm 10.29.3
- Local scripts exist and pass (even if tests are minimal initially):
  - `pnpm -r lint`
  - `pnpm -r typecheck`
  - `pnpm -r test`
  - `anchor test`
  - mobile sanity build step (Expo prebuild/export equivalent)
- CI runs and passes the same gates without secrets.

### Out of scope

- Receipt program logic (beyond scaffold)
- Orca/Whirlpool integration
- Policy engine implementation
- Any auto-execution

## Architecture boundary enforcement

Implementation must comply with `docs/architecture.md`.
`packages/core` must not import Solana SDKs or perform RPC.

## Required repository files

- `pnpm-workspace.yaml`
- `turbo.json`
- `tsconfig.base.json`
- root `package.json` with:
  - `"packageManager": "pnpm@10.29.3"`
  - `"engines": { "node": "22.22.0" }`
- pinned toolchain files (one or more):
  - `.nvmrc` and/or `.tool-versions`
  - `.solana-version`
  - `rust-toolchain.toml`
  - `Anchor.toml`
- `.github/workflows/ci.yml` enforcing gates

## Acceptance criteria (pass/fail)

Pass only if all of the following are true:

1. Fresh clone:
   - `pnpm i --frozen-lockfile` succeeds
2. Workspace quality gates:
   - `pnpm -r lint` succeeds
   - `pnpm -r typecheck` succeeds
   - `pnpm -r test` succeeds
3. Anchor:
   - `anchor test` succeeds (SBF build included)
4. Mobile sanity:
   - `pnpm --filter mobile <expo sanity command>` succeeds
5. CI:
   - runs steps 1–4 and passes on the milestone branch.

## Definition of Done

- All acceptance criteria pass locally and in CI.
- No additional features beyond scaffold/gates are implemented.
