# M17 — E2E harness completion + certification assertions

## Goal
Complete and harden the existing devnet E2E harness so it becomes a real certification tool instead of a thin execution wrapper. This milestone is **not net-new harness creation**. It closes the remaining proof gaps on top of the existing harness in:

- `packages/solana/src/e2eDevnet.ts`

The result must be a repeatable, machine-verifiable certification flow that proves:
- the execution path completed,
- post-execution economic state is correct,
- idempotency holds,
- failure drills are explicit and runnable,
- and the harness output is stable enough for regression tracking.

## Non-goals
- Rebuilding the harness architecture from scratch.
- Adding new swap routers or new execution features.
- Broad UI work.
- Mainnet rollout logic.
- New policy logic beyond what the harness must assert.

## Scope

### In scope
1. Add a canonical structured result artifact with stable fields.
2. Add post-execution state verification.
3. Add explicit named failure drill scenarios.
4. Formalize certification cases and documentation.
5. Ensure `executeOnce()` guarantees the invariants the harness assumes.
6. Formalize HOLD-path outcomes into the same result schema.

### Out of scope
- New runtime capabilities unrelated to certification.
- Replacing existing logger/event infrastructure.
- Portfolio-level or multi-position certification.

---

## Background
The current harness already performs real work, but the proof surface is incomplete.

Known gaps:
1. **No canonical machine-readable result artifact**
   - outcome data is scattered across logger events / JSON lines
   - no stable artifact object/file for regression comparison

2. **No full post-execution position-state verification**
   - receipt existence is checked
   - but economic correctness is not fully asserted:
     - liquidity zero
     - balances changed correctly
     - swap executed or validly skipped
     - fees collected
     - omission reason valid

3. **Failure drills are not first-class certification scenarios**
   - some behavior may exist indirectly
   - but not as formal runnable named drills

4. **Harness depends on `executeOnce()` guarantees that are not explicitly certified**
   - stale quote handling
   - blockhash freshness handling
   - bounded retries
   - deterministic error taxonomy

5. **HOLD path lacks formal outcome object**
   - harness exits and logs
   - but does not emit stable certification output

This milestone closes those gaps.

---

## Requirements

## A) Canonical structured result artifact

Add a stable machine-readable run artifact emitted by the harness for **every run**, including:
- trigger path
- HOLD path
- failure drill scenarios
- expected failures

### Deliverable
Add a canonical result type and serialization path in `packages/solana/src/e2eDevnet.ts` or a nearby module.

Suggested file:
- `packages/solana/src/e2e/resultArtifact.ts`

### Required artifact shape
At minimum, the result artifact must include stable fields:

- `runId`
- `timestamp`
- `cluster`
- `rpcUrl` (sanitized if necessary)
- `position`
- `whirlpool`
- `authority`
- `decision`
- `decisionReasonCode`
- `swapRouter`
- `swapPlanned`
- `swapSkipped`
- `swapSkipReason`
- `txBuilt`
- `txSimulated`
- `txSent`
- `txSignature`
- `receiptPda`
- `receiptFoundBefore`
- `receiptFoundAfter`
- `status` (`PASS` | `FAIL` | `HOLD` | `EXPECTED_FAILURE`)
- `assertions`
- `errors`
- `scenarioName`

### Assertions field
`assertions` must be a stable array or object of named checks, each containing:
- assertion name
- pass/fail
- actual value
- expected value
- optional detail/error code

Minimum assertion names:
- `precheck.receiptAbsent`
- `decision.isExpected`
- `tx.buildSucceeded`
- `tx.simulationSucceeded`
- `tx.confirmed`
- `post.receiptPresent`
- `post.liquidityZero`
- `post.feesCollected`
- `post.balanceDeltaValid`
- `post.swapExecutedOrValidlySkipped`
- `post.duplicateBlocked` (for duplicate scenario)
- `error.matchesExpected` (for expected-failure drills)

### Output behavior
- Result artifact must be emitted even on HOLD.
- Result artifact must be emitted even on failure.
- Harness must support writing artifact to disk as JSON.
- Output path must be deterministic/configurable.

### Invariants
- Artifact schema must be stable across runs.
- Logs are supplementary only. Certification relies on the artifact, not log scraping.

---

## B) Post-execution state verification

This is the primary completion requirement.

After execution, the harness must verify not just receipt presence, but also **economic correctness**.

### Required pre/post snapshot model
The harness must capture enough state before and after execution to verify:

- position liquidity
- relevant token balances
- fee/reward-related balances or deltas
- whether swap should have happened
- whether swap was omitted for a valid reason

Suggested source data:
- position account
- owner token accounts
- relevant ATA / WSOL accounts as needed
- receipt PDA state
- execution plan metadata returned from `executeOnce()`

### Required assertions

#### 1) Liquidity is zero
After successful execution:
- position liquidity must equal `0`

Assertion:
- `post.liquidityZero`

#### 2) Balances changed correctly
After successful execution:
- balance changes must be directionally correct for the intended exit
- exact amounts may vary by fees/slippage/rounding, so assertions must be robust and not naive equality checks

Required behavior:
- downside exit:
  - SOL exposure reduced/removed
  - USDC-side balance increased, unless valid skip
- upside exit:
  - USDC exposure reduced/removed
  - SOL-side balance increased, unless valid skip

Assertion:
- `post.balanceDeltaValid`

#### 3) Swap executed or validly skipped
The harness must verify:
- if swap was planned and not skipped, exposure moved in the intended direction
- if swap was skipped, omission reason is valid and expected

Allowed skip reasons must be explicit and canonical, for example:
- below min swap threshold
- swap router configured as noop for explicit test mode

Not allowed:
- silent omission
- unknown skip reason
- omission because builder/execution path accidentally failed to include swap

Assertion:
- `post.swapExecutedOrValidlySkipped`

#### 4) Fees were collected
The harness must verify fees were actually collected as part of the exit flow.

This does not require exact fee accounting to the last unit if the chain path makes that brittle, but it must verify at least one of:
- fee-related balances increased appropriately, or
- position fee state indicates collection occurred, or
- execution plan/result explicitly proves fee collect instructions executed and produced expected state change

Assertion:
- `post.feesCollected`

#### 5) Receipt present after execution
Existing behavior remains required:
- before: 0 receipts
- after: 1 receipt

Assertions:
- `precheck.receiptAbsent`
- `post.receiptPresent`

---

## C) Explicit named failure drill scenarios

Failure drills must become first-class certification scenarios, not implicit behavior.

### Required certification scenarios
At minimum, make these named runnable scenarios:

1. `happy-path-trigger`
   - full trigger path succeeds
   - receipt written
   - post-state verified

2. `hold-path`
   - decision is HOLD
   - no tx sent
   - artifact emitted with `status=HOLD`

3. `stale-quote-rebuild`
   - stale quote path is exercised
   - rebuild/rejection behavior verified

4. `signing-delay-blockhash-drift`
   - signing delay or stale blockhash path is exercised
   - rebuild/refresh behavior verified

5. `rpc-retry-exhaustion`
   - bounded retry exhaustion is triggered
   - failure is deterministic and classified correctly

6. `unsupported-router-cluster`
   - e.g. Jupiter on devnet
   - fails fast with canonical error

7. `receipt-misconfiguration`
   - missing/wrong receipt program configuration
   - fails fast with canonical error

8. `token2022-certification`
   - explicit certification scenario using a Token-2022-compatible path
   - verifies the path is not just “incidentally supported”

9. `duplicate-execution-same-epoch`
   - first run succeeds
   - second run is blocked deterministically

### Requirements
- Each scenario must produce a canonical result artifact.
- Expected-failure drills must be marked as `EXPECTED_FAILURE`, not `FAIL`, when the correct failure occurs.
- Incorrect failure type or missing canonical error must fail certification.

---

## D) Certification suite formalization

The harness must expose a first-class certification entrypoint that runs named scenarios, not just ad hoc command-line execution.

### Deliverables
Add a certification runner layer, for example:
- `runCertificationScenario(name, config)`
- `runCertificationSuite(config)`

### Certification case behavior
Each case must define:
- scenario name
- inputs / config overrides
- expected outcome
- expected assertions
- expected error codes when failure is intentional

### Documentation
Update runbook/documentation to include:
- how to run one scenario
- how to run full certification suite
- artifact output location
- expected outputs
- how to interpret PASS / HOLD / EXPECTED_FAILURE / FAIL

---

## E) `executeOnce()` invariant guarantees

The harness currently relies on `executeOnce()` to enforce important runtime correctness. That is acceptable architecturally only if those guarantees are explicit and tested.

This milestone must require that `executeOnce()` guarantees the invariants the harness assumes.

### Required guarantees from `executeOnce()`
At minimum:

1. **stale quote rejection/rebuild**
2. **blockhash freshness handling**
3. **bounded retries**
4. **deterministic canonical error taxonomy**
5. **no silent swap omission**
6. **returned execution result includes enough metadata for post-state verification**

### Required deliverable
Document and type the `executeOnce()` result contract.

Suggested return shape includes:
- `decision`
- `swapPlanned`
- `swapSkipped`
- `swapSkipReason`
- `swapRouter`
- `txSignature`
- `receiptPda`
- `preStateSummary`
- `postPlanSummary` or execution intent summary
- `errorCode` on failure

### Requirement
If `executeOnce()` does not already guarantee these invariants, this milestone must close that gap.

---

## F) HOLD path formalization

The HOLD path must emit the same artifact schema as trigger paths.

### Required behavior
On HOLD:
- no tx built/sent
- no receipt write attempted
- artifact emitted with:
  - `status=HOLD`
  - decision fields populated
  - assertions populated appropriately

Minimum HOLD assertions:
- `decision.isExpected`
- `tx.notBuilt`
- `receipt.notAttempted`

This removes ambiguity and makes reporting/automation reliable.

---

## Tests

## Unit tests
Add/extend tests for:
- result artifact schema stability
- HOLD result generation
- expected-failure scenario classification
- assertion formatting/stability
- scenario registry and routing

## Integration tests
Add/extend tests for:
- post-execution verification helpers
- balance delta classification logic
- swap executed vs valid skip classification
- duplicate detection reporting
- executeOnce result contract invariants

## Devnet certification tests
The harness/certification suite must support real devnet runs for:
- happy-path-trigger
- hold-path
- duplicate-execution-same-epoch
- token2022-certification

Other drills may be simulated/mocked where necessary, but the scenario contract must still be first-class and testable.

---

## Deliverables
- canonical result artifact type
- artifact JSON output path and serializer
- post-execution verification helpers
- certification scenario runner
- explicit named failure drills
- documented `executeOnce()` contract/invariants
- HOLD-path artifact support
- updated operator/certification docs

---

## Acceptance criteria (Definition of Done)
1. Existing harness is extended rather than replaced.
2. Every harness run emits a canonical structured result artifact.
3. Successful trigger runs verify:
   - receipt exists after execution
   - liquidity is zero
   - balances changed correctly
   - fees were collected
   - swap executed or validly skipped
4. HOLD runs emit a formal artifact with stable schema.
5. Failure drills are runnable as named scenarios and classified correctly.
6. Certification documentation explains how to run scenarios and interpret artifacts.
7. `executeOnce()` explicitly guarantees the runtime invariants the harness assumes.
8. Regression/certification can rely on artifact files rather than log scraping.

## Notes
- Specialized certification scenarios that require external fixtures, including token2022-certification, must not hard-fail the full suite solely because the fixture is unconfigured or unavailable. They must emit a canonical SKIPPED result artifact with a stable skipReason.
- Every certification scenario must emit a canonical artifact, including skipped scenarios. Skipped scenarios must use status = "SKIPPED" and include a stable machine-readable skipReason. Skips must not be encoded as failures or omitted from reporting.

## Suggested implementation files
- `packages/solana/src/e2eDevnet.ts`
- `packages/solana/src/e2e/resultArtifact.ts`
- `packages/solana/src/e2e/scenarios.ts`
- `packages/solana/src/e2e/assertions.ts`
- related tests alongside existing harness modules