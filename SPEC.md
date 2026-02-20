# SPEC — CLMM Stop-Loss Autopilot (MVP)

This document is **LOCKED for Phase 1 scope**. Any change requires updating this spec + CI gates/tests in the same PR.

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

## Milestones (M0–M6)

Each milestone has a Definition of Done (DoD) that must be met before starting the next milestone.

### M0 — Repo + spec + gates (this PR)

DoD:

- `SPEC.md`, `AGENT.md`, `docs/architecture.md` exist and match this scope
- CI gates exist and run on PRs

### M1 — Monorepo foundations

DoD:

- `packages/core`, `packages/solana`, `apps/web`, `apps/mobile` boundaries in place
- `pnpm -r test`, `pnpm -r lint`, `pnpm -r typecheck` pass locally

### M2 — Receipt program skeleton

DoD:

- Anchor program builds and `anchor test` passes
- Receipt account + PDA derivation defined
- Invariant: one receipt per (position_mint, authority, epoch) enforced by program tests

### M3 — Transaction builder (dry-run)

DoD:

- `packages/solana` builds the **single atomic transaction** (remove+collect+swap+receipt)
- Simulation-first flow implemented
- Unit tests for instruction assembly and parameter validation

### M4 — Monitoring + debounce

DoD:

- Monitoring loop with the Debounce Policy implemented
- Deterministic tests for debounce triggers and cooldown behavior

### M5 — Web UI (Phase 1)

DoD:

- Position selection + alerting
- One-click execution that prompts user signature
- Notifications on success/failure

### M6 — Mobile UI (Phase 1)

DoD:

- Same functional surface as Web (alerts + one-click execution)
- Expo app can be built/exported in CI sanity step
