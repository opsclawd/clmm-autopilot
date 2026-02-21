# SPEC — CLMM Stop-Loss Autopilot (MVP)

This document is **LOCKED for Phase 1 scope**. Any change requires updating this spec + CI gates/tests in the same PR.

Repository architecture boundaries are defined in `docs/architecture.md` and are normative.

## Product definition

A Solana CLMM “Stop-Loss Autopilot” MVP that protects a SOL/USDC Orca Whirlpools concentrated liquidity position with a **bidirectional out-of-range exit policy**.

### Core behavior

Given a Whirlpool LP position with ticks `[lower_tick, upper_tick]` and current price P:

- If **P breaks below `lower_tick`** (per the Debounce Policy):
  1) **Close** the position (remove liquidity + collect fees/rewards)
  2) Swap any resulting **SOL exposure → USDC**
  3) Record an on-chain **execution receipt** in the same transaction

- If **P breaks above `upper_tick`** (per the Debounce Policy):
  1) **Close** the position (remove liquidity + collect fees/rewards)
  2) Swap any resulting **USDC exposure → SOL**
  3) Record an on-chain **execution receipt** in the same transaction

### Atomic execution (hard requirement)

**One transaction** must contain:

- remove liquidity
- collect fees/rewards
- swap (direction depends on exit side)
- receipt program instruction

No multi-tx “best effort” execution in Phase 1.

## Non-goals (Phase 1)

- No auto-execution
- No delegated signing
- No background bot / keeper / cron executor
- No custody of user keys

Phase 1 requires that the **user signs every execution**.

## Supported targets (first-class)

- **Web:** Next.js app
- **Mobile:** **Expo React Native + MWA** (mobile-first requirement; not “Phase 2”)

## Cross-cutting canonical definitions (LOCKED)

- **Epoch (Phase 1 canonical):** `unixDays = floor(unixTs / 86400)` (UTC day bucket).
  - `epoch` used in receipts and idempotency checks MUST use this definition.
- **Direction encoding (canonical):** `u8`
  - `0 = DOWN`
  - `1 = UP`
  - TS and on-chain representations must keep this exact mapping.
- **Canonical error taxonomy (shared across core/solana/UI):**
  - `DATA_UNAVAILABLE`
  - `RPC_TRANSIENT`
  - `RPC_PERMANENT`
  - `INVALID_POSITION`
  - `NOT_SOL_USDC`
  - `ALREADY_EXECUTED_THIS_EPOCH`
  - `QUOTE_STALE`
  - `SIMULATION_FAILED`
  - `SLIPPAGE_EXCEEDED`
  - `INSUFFICIENT_FEE_BUFFER`
  - `BLOCKHASH_EXPIRED`

## Receipt program invariant (LOCKED)

The receipt program must enforce:

- **At most one receipt per (position_mint, authority, epoch)**
- Receipt is included in the **same transaction** as execution.

Definitions:

- `position_mint`: Whirlpool position NFT mint
- `authority`: wallet that owns/controls the position
- `epoch`: a deterministic epoch number (defined in the receipt program; e.g., Solana epoch)

Failure mode: if a receipt already exists for the tuple, the transaction must fail.

## Debounce policy (explicit + testable)

Sampling:

- The app reads price samples at a fixed cadence: **every 2 seconds**.

Trigger rule:

- A **DOWN exit** is triggered when **3 consecutive samples** are **below** `lower_tick`.
- An **UP exit** is triggered when **3 consecutive samples** are **above** `upper_tick`.

Cooldown:

- After a trigger condition is satisfied (either direction), enter a **cooldown of 90 seconds** during which **no new trigger** is emitted.

Reset:

- If any sample in the sequence is not out-of-range in the trigger direction, the consecutive counter resets to 0.

This policy is intended to debounce wick moves and is the baseline for Phase 1.

### Sampling source definition (authoritative)

Signal used for debounce and range-break detection: Whirlpool current tick from on-chain pool state.

- The system reads the Whirlpool pool account and derives `currentTickIndex` (tick index).
- Range comparison is performed strictly in tick space:
  - `below` means `currentTickIndex < lowerTickIndex`
  - `above` means `currentTickIndex > upperTickIndex`
  - `inRange` means `lowerTickIndex <= currentTickIndex <= upperTickIndex`
- The debounce sampler records a time-series of `(slot, unixTs, currentTickIndex)` samples at the configured interval.
- Price floats (e.g., UI price) are not used for trigger decisions.
- If `currentTickIndex` cannot be fetched or decoded reliably, the policy returns `HOLD` and surfaces a `DATA_UNAVAILABLE` reason (no trigger on missing data).

## Slippage + safety (LOCKED)

### Hard caps

- Swaps must use a **max slippage cap**: **50 bps** (0.50%).
- Slippage cap is **not adaptive**. No widening on retries.

### Simulation required

Before prompting the user to sign:

- The app must **simulate** the full transaction.
- If simulation fails, **do not send**.

### Fee buffer

- Maintain a fixed **fee buffer** to cover compute + priority fees: **0.01 SOL** minimum balance reserved.
- If buffers cannot be satisfied, execution is blocked and the user is notified.

### Compute budget

- Include explicit compute budget instructions:
  - compute unit limit
  - compute unit price (priority fee)

(Exact numbers can be tuned, but inclusion is mandatory.)

### Retries

- **Fetch retries:** allowed (e.g., RPC reads), max **3** attempts with exponential backoff.
- **Send retries:** constrained, max **1** retry only if the failure is clearly transient (e.g., blockhash not found).
- **Never loop on failure.** If the send fails after the retry policy, stop and notify.

## Milestones

### M0 — Repo scaffold + deterministic gates (DONE)

Goal: Establish a reproducible monorepo with web + mobile shells, shared packages, Anchor workspace, and CI gates that prevent drift.

Deliverables

- Monorepo layout exists:
  - `apps/web` (Next.js)
  - `apps/mobile` (Expo RN)
  - `packages/core` (pure TS, no Solana deps)
  - `packages/solana` (Solana integration package; may be stubbed)
  - `programs/receipt` (Anchor program scaffold)
  - `docs/architecture.md`, `AGENT.md`, `SPEC.md`
- Toolchain pinned in-repo (Node, pnpm, Solana/Agave, Anchor, Rust toolchain)
- Root scripts exist for lint/typecheck/test (even if tests are initially minimal)
- CI runs (and passes):
  - install with pinned pnpm
  - lint + typecheck + test
  - install Solana CLI + Anchor
  - build SBF and run anchor test
  - mobile sanity step (Expo prebuild/export equivalent) without secrets

Definition of Done

- Fresh clone passes:
  - `pnpm i --frozen-lockfile`
  - `pnpm -r lint`
  - `pnpm -r typecheck`
  - `pnpm -r test`
  - `anchor test`
  - mobile sanity build step
- CI passes with the above gates.

---

### M1 — Foundations: boundaries enforced + real test harness + mobile wallet signing smoke test

Goal: Turn scaffolding into a stable base where shared logic is testable, platform boundaries are enforced, and mobile signing works.

Deliverables

- `packages/core`
  - real unit test harness (Vitest/Jest) with at least one meaningful test suite
  - zero Solana SDK imports enforced (lint rule / dependency rule / CI check)
- `packages/solana`
  - RPC client wrapper + typed config + “build unsigned tx” placeholder API (no Orca logic yet)
  - integration test harness wired (can use local validator or mocked RPC fixtures)
- `apps/mobile`
  - Mobile Wallet Adapter (MWA) integrated
  - “sign message” or “sign & send a noop tx” smoke path on devnet/test validator
- `apps/web`
  - wallet connect + minimal dev console page that can call shared packages

Definition of Done

- `packages/core` contains non-trivial unit tests and they run in CI.
- A boundary gate exists that fails CI if `packages/core` imports Solana SDKs.
- Mobile app can sign via MWA in a reproducible dev flow (documented runbook).
- No Orca/Whirlpool integration yet.

---

### M2 — Receipt program implementation (Anchor) + invariant tests

Goal: Implement the minimal on-chain execution receipt to prevent duplicate execution per epoch and provide auditability.

Deliverables

- Anchor program `receipt` implements:
  - `record_execution(epoch, direction, position_mint, tx_sig_hash)`
  - PDA keyed by `(position_mint, authority, epoch)`
  - stored fields: authority, position_mint, epoch, direction, tx_sig_hash, timestamp/slot
- Anchor tests:
  - first call creates receipt
  - second call same `(position_mint, authority, epoch)` fails deterministically
  - different epoch succeeds
  - invalid authority rejected
- TS client helpers generated and usable from `packages/solana`

Definition of Done

- `anchor test` proves invariants (no “happy path only”).
- Receipt ix can be composed into a transaction by the TS layer.

---

### M3 — Policy engine (pure TS): range state machine + debounce + cooldown

Goal: Build the stop-loss trigger decision logic in `packages/core` with exhaustive unit tests.

Deliverables

- State machine outputs: `HOLD | TRIGGER_DOWN | TRIGGER_UP`
- Debounce rules implemented exactly as specified (sampling source defined below)
- Cooldown + reentry handling
- Unit tests cover wick reentry, sustained break, cooldown behavior

Definition of Done

- All policy behavior is deterministic and fully covered by tests.
- No RPC or SDK usage in `packages/core`.

---

### M4 — Orca Whirlpool position inspector (read-only)

Goal: Reliably load a Whirlpool position and compute “in-range” vs “out-of-range” plus removal preview.

Deliverables

- `packages/solana` can fetch:
  - position state, whirlpool state, ticks/tick arrays needed
  - current tick + lower/upper ticks + tick spacing
  - token mints + decimals
  - removal preview / expected amounts (best-effort; no execution)
- Integration tests against fixtures or local validator.

Definition of Done

- Snapshot function returns a stable typed object used by web/mobile shells.

---

### M5 — One-click execution builder: remove + collect + swap + receipt (unsigned)

Goal: Build the exact transaction that a user signs: close position + convert exposure + write receipt, with strict guards.

Deliverables

- Unsigned transaction builder that:
  - remove liquidity + collect fees
  - swap remaining exposure into target side (downside SOL→USDC, upside USDC→SOL)
  - appends `record_execution` ix in same transaction
  - enforces simulation gate, slippage cap, fee buffer, compute budget
  - limited retries only for fetch/quote refresh, not blind resend loops

Definition of Done

- Deterministic failure modes (tight slippage aborts, stale quote aborts).
- Integration tests cover tx composition and guardrails.

---

### M6 — Shell UX: monitor + alert + execute (web + mobile) + notifications stub

Goal: Expose the workflow to users: monitor, confirm trigger, execute with signature.

Deliverables

- Web dev console: connect wallet, input position, display state, execute button
- Mobile UI: same flow, store-grade minimal UX
- Notification stub (log + pluggable adapter), no background auto-exec

Definition of Done

- End-to-end devnet runbook: user can execute a triggered exit with receipt recorded.

---

### M7 — Reliability hardening (minimum viable)

Goal: Survive fast markets and common RPC failure modes without unsafe behavior.

Deliverables

- blockhash refresh + rebuild-on-change logic
- quote freshness rules + rebuild tx if price moved materially
- idempotency checks via receipt before building tx
- bounded retries + explicit failure states
- operational telemetry hooks (structured logs)

Definition of Done

- Documented failure modes and deterministic safeguards.
- No “auto widen slippage” behavior in Phase 1.
