# Spec Traceability (M0-M19)

| Milestone | Status | Evidence |
| --- | --- | --- |
| M0 scaffold + deterministic gates | partial | CI workflow and pinned toolchains are present; added `turbo.json` and `tsconfig.base.json` to match spec-required scaffold artifacts. |
| M1 foundations | met | Core boundary gate exists (`scripts/check-core-boundaries.mjs`), core tests/harness are active, mobile MWA smoke path exists. |
| M2 receipt program | met | Receipt program + tests exist; runtime path now appends live receipt ix via resolver-gated identity and enforces duplicate rejection deterministically. |
| M3 policy engine | met | `packages/core/src/policy.ts` with deterministic debounce/cooldown logic and tests. |
| M4 orca inspector | met | Inspector loads snapshot fields, pair guardrails, tick-array derivation/cache, normalized errors, decode module isolation. |
| M5 execution builder | met | Builder ordering/guards/simulation are implemented with resolver-gated receipt append (no feature-flag bypass). |
| M6 shell UX | met | Web/mobile shell flows and UI state run against the live resolver-gated receipt execution path. |
| M7 reliability hardening | met | Rebuild/refresh/retry logic implemented and tested in `reliability.ts` + `executeOnce.ts`. |
| M8 pair guardrails | met | Canonical mint registry + SOL/USDC assertions in core and solana runtime paths. |
| M9 attestation hash | met | Canonical payload encoding + hashing in core, builder enforces hash/payload consistency. |
| M10 config centralization | partial | Typed central config is in place; UI sample buffer moved to config (`ui.sampleBufferSize`), mobile runtime RPC/commitment now config-driven. |
| M11 dust swap skip | met | `decideSwap` and conditional Jupiter inclusion with tests for dust skip behavior. |
| M12 devnet e2e harness | met | Harness verifies receipt program presence + `0 -> 1` receipt state + deterministic duplicate block in same epoch. |
| M13 orca decode stabilization | met | Runtime decode path uses centralized `orca/decode.ts` with fixtures and explicit `ORCA_DECODE_FAILED` normalization. |
| M14 swap adapters | met | Core swap adapter contract/types + router-aware attestation fields + explicit adapter implementations/registry in solana; execute path and devnet harness now route through configured adapter with cluster gating (`SWAP_ROUTER_UNSUPPORTED_CLUSTER`). |
| M15 devnet receipt deploy | met | Deploy-derived manifest + deterministic IDL hash gate + consistency guard + manual devnet workflow updates are in place. |
| M16 token2022 first-class | met | Token-program resolver + LRU cache + terminal unsupported owner errors are wired; requirements owns ATA existence planning via `missingAtas`; builder consumes plan-only ATA creation; Whirlpool remove/collect/swap share v1/v2 selector with unconditional memo on v2; matrix-focused tests were added. |
| M17 e2e harness completion | met | Devnet harness now emits canonical `schemaVersion:1` artifacts for all outcomes, includes post-state economic assertions (liquidity/balances/fees/swap-or-valid-skip), and exposes first-class scenario/suite certification runners. |
| M18 production readiness guardrails | met | Core config now carries explicit operator runtime mode + paused default with cluster-safe defaults; Solana runtime adds RPC/runtime validation, a single execution gate, structured event envelopes, and in-memory counters; web/mobile shells surface effective operator state and session pause override; runbook/checklist updates document mode, pause precedence, and observability expectations. |
| M19 mainnet shadow mode | met | Core config adds `executionMode` + mainnet alias normalization and send-enable matrix; Solana runtime uses structural transport enforcement (`ShadowSubmitter`) and shadow-only send prohibition; new mainnet shadow runner writes deterministic SQLite artifacts (`shadow_evaluations`, `shadow_triggers`, `shadow_metrics_rollups`) with cold-start markers, position-source mode, simulation classification, and zero-send counters; runbook/checklist updated with M19 promotion gates. |
