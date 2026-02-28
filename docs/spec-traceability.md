# Spec Traceability (M0-M14)

| Milestone | Status | Evidence |
| --- | --- | --- |
| M0 scaffold + deterministic gates | partial | CI workflow and pinned toolchains are present; added `turbo.json` and `tsconfig.base.json` to match spec-required scaffold artifacts. |
| M1 foundations | met | Core boundary gate exists (`scripts/check-core-boundaries.mjs`), core tests/harness are active, mobile MWA smoke path exists. |
| M2 receipt program | partial | Receipt program + tests exist; duplicate now returns deterministic custom error (`DuplicateExecutionReceipt`). Runtime receipt instruction remains deferred behind feature flag. |
| M3 policy engine | met | `packages/core/src/policy.ts` with deterministic debounce/cooldown logic and tests. |
| M4 orca inspector | met | Inspector loads snapshot fields, pair guardrails, tick-array derivation/cache, normalized errors, decode module isolation. |
| M5 execution builder | partial | Builder ordering/guards/simulation are implemented; receipt append is deferred by `DISABLE_RECEIPT_PROGRAM_FOR_TESTING`. |
| M6 shell UX | partial | Web/mobile shell flows and UI state are implemented; full runtime behavior is constrained by deferred receipt-program flag. |
| M7 reliability hardening | met | Rebuild/refresh/retry logic implemented and tested in `reliability.ts` + `executeOnce.ts`. |
| M8 pair guardrails | met | Canonical mint registry + SOL/USDC assertions in core and solana runtime paths. |
| M9 attestation hash | met | Canonical payload encoding + hashing in core, builder enforces hash/payload consistency. |
| M10 config centralization | partial | Typed central config is in place; UI sample buffer moved to config (`ui.sampleBufferSize`), mobile runtime RPC/commitment now config-driven. |
| M11 dust swap skip | met | `decideSwap` and conditional Jupiter inclusion with tests for dust skip behavior. |
| M12 devnet e2e harness | partial | Harness + runbook + receipt verification logic exist; runtime behavior remains partially deferred by receipt-program flag. |
| M13 orca decode stabilization | met | Runtime decode path uses centralized `orca/decode.ts` with fixtures and explicit `ORCA_DECODE_FAILED` normalization. |
| M14 swap adapters | met | Core swap adapter contract/types + router-aware attestation fields + explicit adapter implementations/registry in solana; execute path and devnet harness now route through configured adapter with cluster gating (`SWAP_ROUTER_UNSUPPORTED_CLUSTER`). |

## Deferred by Design

- Keep `DISABLE_RECEIPT_PROGRAM_FOR_TESTING=true`.
- These deferred items are intentional and tracked for upcoming milestones.
