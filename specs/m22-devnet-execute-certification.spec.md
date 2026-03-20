# M22 — Devnet execute certification + operator flow hardening

## Summary
Turn the current devnet certification harness into a repeatable live-execution gate for the real exit path, not just receipt proof or shadow-style simulation.

M22 certifies both trigger directions on devnet with actual execution:

- `trigger-down`: below lower tick -> close LP -> collect -> swap SOL exposure into USDC
- `trigger-up`: above upper tick -> close LP -> collect -> swap USDC exposure into SOL

The milestone extends M17, M19, and M21 by proving:

- live execution works end-to-end on devnet in both directions
- execution fails closed under quote/sign/send friction
- post-trade balances, liquidity, and local receipt state end in the expected terminal shape
- the operator can see one clean sign/submit/confirm path with deterministic evidence

The primary proof target is execution correctness. Receipt handling remains important, but it is no longer the main certification claim.

## Problem
The repo already has:

- a devnet certification harness
- bounded retry and blockhash refresh logic
- local SQLite receipt lifecycle
- structured result artifacts

But the current certification surface is still too narrow for promotion decisions.

Known gaps:

1. both trigger directions are not yet certified as first-class live execute lanes
2. the scenario matrix does not yet cover the full friction set that matters in production-like execution
3. post-trade assertions are not yet strict enough about terminal portfolio shape and exact local receipt lifecycle
4. operator-facing outputs do not yet provide one stable execution summary that shows what was attempted, signed, sent, and confirmed
5. repeatability still relies too much on ad hoc position selection instead of a deterministic certification fixture strategy

Until those gaps are closed, devnet cannot serve as a trustworthy promotion gate for shadow-on-mainnet readiness.

## Goals
- Certify live end-to-end execution on devnet for both `trigger-down` and `trigger-up`.
- Expand the certification suite into a deterministic scenario matrix for the execute path.
- Prove stale quotes, slippage breaches, unsupported routes, insufficient fee buffer, and retry exhaustion fail closed.
- Assert post-trade liquidity, balances, collected fees/rewards, and receipt state with direction-aware checks.
- Provide one operator-visible execution summary for the one-click sign path.
- Define a stable failure taxonomy and promotion rubric for advancing to mainnet shadow operation.

## Non-goals
- Mainnet live execution.
- Re-entry, rebalancing, or portfolio optimization.
- New trading logic beyond the existing trigger policy and exit path.
- Adding net-new swap routers outside the current supported adapter model.
- Building an unattended background executor.

## Scope

### In scope
- extending `packages/solana/src/e2eDevnet.ts` into a live execute certification suite
- expanding `packages/solana/src/e2e/scenarios.ts` into a direction-aware scenario matrix
- strengthening `packages/solana/src/executeOnce.ts` postconditions and failure surfacing
- extending the certification artifact schema and execution summary output
- local receipt duplicate-block and retry-state certification
- deterministic devnet fixture sourcing or provisioning for repeatable runs
- operator runbook updates for live devnet certification and promotion review

### Out of scope
- replacing the harness architecture from scratch
- changing the canonical trigger policy
- changing the current local-receipt data model beyond what is needed for certification evidence
- broad UI redesign beyond minimal operator execution surfacing

## Requirements

## A) Live execute certification target
M22 must certify the actual live execute path on devnet.

### Required runtime mode
- `cluster = "devnet"`
- `executionMode = "devnet-live"`
- `runtimeMode = "execute"`
- `execution.sendEnabled = true`

### Hard requirement
Certification evidence is valid only if it uses the same decision, build, sign, send, confirm, and post-check path used for live execution.

The following do **not** satisfy M22 by themselves:

- alert-only flows
- simulation-only runs
- shadow-mode artifacts
- receipt-only proof without swap and terminal-balance validation

### Receipt mode
M22 certifies the M21 receipt model:

- local SQLite receipt state is authoritative for same-epoch duplicate blocking
- on-chain receipt may remain enabled as a compatibility lane, but it is not the primary acceptance gate for M22

If devnet runs with `execution.onChainReceiptEnabled=true`, all local receipt assertions still apply and local confirmation must not occur before the on-chain receipt verification step succeeds.

## B) Deterministic fixture strategy
The suite must be repeatable enough to run before every promotion decision.

### Required fixture model
The certification flow must use one deterministic source of fresh devnet positions:

- provision fresh positions before the suite, or
- consume explicit direction-specific candidate inventories and deterministically select a fresh candidate

### Requirements
- `trigger-down` and `trigger-up` may use different devnet positions
- each live execute scenario must consume a position that is fresh for the current epoch unless the scenario explicitly tests duplicate or retry behavior
- selection order must be deterministic
- fixture preparation steps must be documented in the runbook
- artifact output must record which fixture source was used

Ad hoc manual copy/paste of arbitrary positions is not sufficient as the only certification path.

## C) Scenario matrix
The certification suite must formalize a minimum direction x scenario matrix.

### Directions
- `DOWN`
- `UP`

### Minimum scenarios per direction
- `happy-path-execute`
- `hold-path-debounce`
- `stale-quote-rebuild`
- `signing-delay-blockhash-drift`
- `rpc-retry-exhaustion`
- `unsupported-router-cluster`
- `insufficient-fee-buffer`
- `slippage-cap-breach`
- `duplicate-execution-same-epoch`
- `local-receipt-pending-blocker`
- `local-receipt-failed-retry`

### Additional execute-hardening drill
Unsupported route rejection must be certified as a first-class expected-failure drill.

If that drill cannot be induced against live devnet deterministically, it must still exist as a harness scenario with stable artifact output and deterministic adapter-level evidence.

### Scenario output requirement
Every scenario must emit a canonical structured artifact, including:

- `PASS`
- `FAIL`
- `HOLD`
- `EXPECTED_FAILURE`
- `SKIPPED` only when the fixture source cannot provide a valid candidate and the skip reason is explicit

## D) Quote and execution hardening
This is the main technical certification surface.

### 1) Quote freshness windows
The suite must assert that quote freshness thresholds are enforced from config and surfaced in artifacts.

Required evidence:
- quote age at build time
- freshness thresholds used
- whether the original quote was accepted or rebuilt

### 2) Stale quote rebuild
If a quote becomes stale by time, slot, or tick movement, the execute path must rebuild before signing/sending.

Required behavior:
- stale quote does not silently proceed
- rebuild reason is stable and canonical:
  - `QUOTE_STALE`
  - `BOUND_CROSSED`
  - `TICK_MOVED`
- artifact shows whether rebuild happened and why

### 3) Slippage cap enforcement
The configured slippage cap remains a hard ceiling.

Required behavior:
- no retry may widen slippage above config
- slippage breach must fail closed with `SLIPPAGE_EXCEEDED`
- artifact must record configured cap and min-out used

### 4) Fee buffer sufficiency
The execute path must verify fee buffer sufficiency before send.

Required behavior:
- insufficient buffer must fail closed with `INSUFFICIENT_FEE_BUFFER`
- no wallet prompt or send attempt after a deterministic fee-buffer failure
- artifact must show available lamports, required reserve, and failure phase

### 5) Blockhash drift handling
The execute path must handle signing delay and expired blockhashes deterministically.

Required behavior:
- if signing delay or send response indicates drift/expiry, blockhash refresh runs exactly through the bounded refresh path
- send retry remains bounded by the existing retry policy
- artifact shows whether blockhash refresh occurred and how many send attempts were used

### 6) Retry ceilings
Retries must be bounded and observable.

Required behavior:
- per-operation retry counts must be recorded in the artifact
- exhaustion must fail closed with a stable code
- no unbounded retry loops

### 7) Unsupported route rejection
Unsupported router/cluster combinations and unsupported returned routes must both fail closed before send.

Required behavior:
- unsupported router/cluster fails with `SWAP_ROUTER_UNSUPPORTED_CLUSTER`
- unsupported route plan fails with a stable code introduced by M22
- no fallback to an unapproved route

### 8) Partial-failure behavior
Post-send and post-confirmation failures must not be reported as success.

Required behavior:
- local receipt must never be marked `confirmed` on partial failure
- failure metadata must be durable and retryable where appropriate
- artifact must show failure phase and whether any tx signature was observed

## E) Post-trade accounting correctness
After a successful live execute run, the suite must assert economic postconditions, not just transaction success.

### Required pre/post snapshots
The harness must capture enough state to compare:

- position liquidity
- owner token balances for both pool tokens
- SOL lamports
- fee/reward-related balances or equivalent collectible state
- local receipt status before and after

### Required postconditions

#### 1) Liquidity closed
- LP liquidity must be `0`, or within an explicit residual dust threshold recorded in the artifact

#### 2) Fees and rewards collected
- fees/rewards must be collected as expected, or the artifact must explicitly show that there was nothing collectible
- silent omission is not allowed

#### 3) Directional balance movement
For `trigger-down`:
- SOL exposure must decrease to zero or dust-only residual
- USDC-side balance must increase, unless swap omission is explicitly valid and recorded

For `trigger-up`:
- USDC exposure must decrease to zero or dust-only residual
- SOL-side balance must increase, net of fees and configured reserve behavior

#### 4) Final portfolio shape
The final wallet state must match the exit direction:

- `trigger-down` terminal shape: closed LP plus primarily USDC exposure, with only expected SOL fee reserve and dust
- `trigger-up` terminal shape: closed LP plus primarily SOL exposure, with only expected USDC dust

Portfolio-shape thresholds must be explicit and deterministic in the harness.

#### 5) Receipt confirmation exactly once
- a successful run must transition the local receipt row through the expected lifecycle exactly once
- duplicate same-epoch confirmation must not occur
- artifact must show precheck status, claim status, terminal status, and confirmed signature/slot metadata

## F) Local receipt and duplicate protection behavior
M22 must certify the M21 local receipt semantics on the live execute path.

### Required behaviors
1. Existing confirmed local receipt blocks same-epoch re-execution with `ALREADY_EXECUTED_THIS_EPOCH`.
2. Existing fresh pending local receipt blocks send deterministically with a stable M22 code.
3. A failed local receipt row remains retryable through the documented recovery path.
4. Local receipt confirmation happens exactly once for a successful execution.
5. Local receipt failure metadata is durable and operator-visible.

### Hard requirement
Duplicate-execution prevention for M22 is judged primarily through the local SQLite ledger, not through wallet/UI timing or log-only heuristics.

## G) Operator flow and one-click execution summary
M22 must provide one clean operator path from trigger observation to confirmation outcome.

### Required operator flow
1. trigger observed
2. execution intent rendered
3. one-click sign path built
4. transaction submitted
5. confirmation/failure surfaced clearly
6. duplicate retry blocked locally for the same epoch

### Required execution summary
The operator-facing summary must show, at minimum:

- trigger direction and reason
- position and whirlpool
- current/lower/upper tick
- remove-liquidity / collect / swap intent
- router, input amount, min out, slippage cap, and quote age
- local receipt status before and after
- whether quote rebuild happened
- whether blockhash refresh happened
- retry counts
- whether the wallet was prompted
- tx signature if submitted
- final success or stable error code

### UX constraint
For Phase 1 execution, the operator flow still represents one execution transaction. M22 must not introduce a multi-transaction best-effort exit path.

## H) Artifact and evidence model
The certification artifact must be extended so promotion review does not depend on log scraping.

### Required artifact changes
Extend the current result artifact with stable fields for:

- `direction`
- `liveExecutionRequired`
- `failurePhase`
- `quote`
  - age
  - freshness threshold
  - rebuild happened
  - rebuild reason
- `retries`
  - per operation
  - exhausted or not
- `blockhash`
  - refreshed or not
  - send attempts
- `localReceipt`
  - precheck status
  - claimed
  - confirmed
  - failed
  - terminal row metadata summary
- `postTrade`
  - liquidity before/after
  - token deltas
  - fee/reward collection summary
  - portfolio-shape verdict
- `operatorSummary`
  - what was attempted
  - what was signed
  - what was sent
  - what was confirmed

### Evidence requirement
Promotion evidence must come from these artifacts plus the documented fixture/run commands, not from manual screenshots or free-form logs alone.

## I) Failure taxonomy
M22 must provide stable error codes for execute-certification outcomes.

### Reuse existing canonical codes where already available
- `ALREADY_EXECUTED_THIS_EPOCH`
- `QUOTE_STALE`
- `SLIPPAGE_EXCEEDED`
- `INSUFFICIENT_FEE_BUFFER`
- `BLOCKHASH_EXPIRED`
- `SWAP_ROUTER_UNSUPPORTED_CLUSTER`
- `SIMULATION_FAILED`
- `RPC_TRANSIENT`
- `RPC_PERMANENT`

### Add stable codes for gaps exposed by M22
- `RETRY_EXHAUSTED`
- `UNSUPPORTED_SWAP_ROUTE`
- `LOCAL_RECEIPT_PENDING`
- `POSTCONDITION_FAILED`

### Failure metadata
Every failure artifact must include:

- stable `errorCode`
- stable `failurePhase`
- retryable vs terminal classification
- underlying tx signature when one exists

## J) Tests

### Unit tests
- scenario matrix generation is deterministic and direction-aware
- post-trade assertion helpers classify terminal shape correctly for both directions
- failure taxonomy mapping is stable
- operator summary object is generated with required fields

### Integration tests
- `executeOnce()` rebuilds stale quotes and records the reason
- blockhash drift triggers bounded refresh behavior
- retry exhaustion stops at the configured ceiling
- unsupported route rejection fails before send
- local receipt pending blocks send
- local receipt failed rows are retryable through the documented path
- successful execution confirms the local receipt exactly once

### Devnet acceptance runs
The suite must produce artifact evidence for:

- both happy-path execute directions on fresh devnet positions
- expected-failure drills across the minimum matrix
- duplicate same-epoch local blocking
- post-trade terminal-shape assertions

CI does not need to depend on live devnet, but the suite must remain runnable as a repeatable pre-promotion command set.

## Deliverables
- direction-aware devnet execute certification suite
- deterministic scenario matrix for the execute path
- extended artifact schema and operator execution summary
- post-trade assertion coverage for balances, liquidity, and local receipt lifecycle
- stable failure taxonomy for execute certification
- runbook updates for fixture prep, execution, triage, and promotion review

## Acceptance criteria
M22 is done only when all of the following are true with artifact evidence:

1. Both trigger directions execute end-to-end on devnet.
2. Exit plus swap leaves the wallet and position state in the expected terminal shape.
3. Same-epoch duplicate execution is blocked locally.
4. Bad quotes, bad routes, slippage breaches, insufficient fee buffer, and retry exhaustion fail closed.
5. The operator can see exactly what was attempted, signed, sent, and confirmed.
6. The suite is deterministic enough to run before every promotion decision.

## Promotion rubric: safe enough to shadow on mainnet
M22 must define a concrete promotion gate for enabling the next mainnet-shadow step.

Minimum rubric:

- at least three consecutive full-suite runs complete with no unexplained `FAIL`
- both `trigger-down` and `trigger-up` happy-path execute runs pass on fresh fixtures
- all expected-failure drills end in `EXPECTED_FAILURE` with matching stable error codes
- zero unknown or uncategorized failure artifacts remain in the promotion window
- zero duplicate-confirmation anomalies appear in the local receipt ledger
- operator summary output is sufficient for an independent reviewer to reconstruct what happened without reading raw logs

Until those conditions are met, promotion to the next shadow stage remains blocked.
