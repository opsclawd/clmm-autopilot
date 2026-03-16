# M19 — Mainnet shadow mode (no execution, real decisioning)

## Goal
Run the full autopilot decision pipeline against **mainnet** positions in a strictly non-executing mode so the system can observe, evaluate, quote, build, and simulate candidate exits without sending transactions. The objective is to validate production decision quality and operational reliability against real market conditions before enabling live execution.

## Why this milestone exists
Devnet proves the code can work. It does **not** prove the system should be trusted on mainnet.

Mainnet shadow mode exists to answer these questions with evidence:
- Does the monitor classify range state correctly on real positions?
- Does debounce suppress noise and fakeouts as intended?
- Would the system have triggered at the right times?
- Can it consistently build and simulate valid transactions on mainnet?
- Do swap quotes remain usable under real liquidity and latency conditions?
- Do Token-2022, receipt config, and cluster routing behave correctly on production infrastructure?
- How often would execution have failed, and why?

Until shadow mode is stable, enabling live mainnet execution is premature.

## Non-goals
- Sending any transaction to mainnet.
- Writing on-chain receipts on mainnet.
- Auto-executing exits.
- Rebalancing or re-entry logic.
- Multi-position portfolio optimization.
- Alert delivery system expansion beyond minimal operator visibility already in scope.

## Scope

### In scope
1) Mainnet monitoring and policy evaluation for real positions.
2) Candidate exit planning:
   - remove liquidity
   - collect fees/rewards
   - swap exposure
   - receipt write step represented logically, but not sent
3) Transaction simulation on mainnet where possible.
4) Persistent shadow-run records for later analysis.
5) Operator-facing reporting of:
   - what would have happened
   - why
   - whether the tx would likely have succeeded
6) Comparative analysis for trigger quality and simulation success rate.

### Out of scope
- Live execution.
- User signature requests on mainnet.
- Writing receipt accounts on-chain.
- Performance optimization beyond what is needed to run shadow mode reliably.
- New strategy logic beyond existing stop-loss/autopilot behavior.

## Requirements

## A) Execution mode support
Introduce a formal execution mode in config:

- `executionMode: "devnet-live" | "mainnet-shadow" | "mainnet-live"`  
  or equivalent enum already consistent with the codebase.

### Rules
- In `mainnet-shadow`:
  - policy engine runs normally
  - swap adapter selection runs normally
  - quote fetching runs normally
  - tx builder runs normally
  - simulation runs normally
  - **send/sign path is disabled**
  - **receipt write is not submitted on-chain**
  - receipt identity must still resolve successfully so the receipt step can be validated structurally
- Any attempt to send a transaction in `mainnet-shadow` must hard-fail with a canonical error:
  - `EXECUTION_MODE_SEND_FORBIDDEN`

## B) Shadow-run pipeline
For each monitored position, the shadow pipeline must support:

1) fetch position snapshot
2) compute range state
3) run debounce logic
4) determine whether an exit trigger would fire
5) if no trigger:
   - record non-trigger evaluation
6) if trigger fires:
   - build candidate execution plan
   - obtain quote via configured swap adapter
   - build transaction instructions
   - simulate transaction
   - record result as a shadow decision artifact

### Hard requirement
Shadow mode must use the **same decisioning and tx-building code paths** as live mode, with only the final send/write side effects disabled.

No parallel “fake logic” paths are allowed.

## C) Candidate execution artifact
Each trigger event in shadow mode must produce a persistent structured artifact.

### Required fields
- `timestamp`
- `cluster = "mainnet"`
- `executionMode = "mainnet-shadow"`
- `positionAddress`
- `authority`
- `whirlpoolAddress`
- `direction` (`trigger_up` or `trigger_down`)
- `currentTick`
- `lowerTick`
- `upperTick`
- `debounceCount`
- `swapRouter`
- `quoteSummary`
  - in amount
  - min out
  - slippage bps
  - quote age
- `txBuildStatus`
- `simulationStatus`
- `simulationErrorCode` (if any)
- `candidateInstructionSummary`
- `wouldExecute: boolean`
- `wouldFailReason` (if false)
- `receiptPdaExpected` (if receipt path is part of logical plan)
- `tokenProgramSummary`
  - mintA program
  - mintB program

### Storage
Artifacts may be stored in:
- local JSONL files
- SQLite
- Postgres
- equivalent persistence already used in the project

The storage choice must be explicit and deterministic. Do not keep shadow results only in logs.

## D) Simulation behavior
When a trigger fires in shadow mode, the system must attempt to simulate the candidate transaction.

### Requirements
- Use mainnet RPC.
- Include the exact instructions that would be used in live mode, except:
  - sending is disabled
  - actual receipt write ix may be omitted or logically stubbed depending on builder constraints
- Simulation result must be classified into canonical categories:
  - `SIM_OK`
  - `SIM_RPC_ERROR`
  - `SIM_ACCOUNT_MISSING`
  - `SIM_QUOTE_STALE`
  - `SIM_SLIPPAGE_EXCEEDED`
  - `SIM_TOKEN2022_ACCOUNT_MISMATCH`
  - `SIM_RECEIPT_CONFIG_ERROR`
  - `SIM_UNKNOWN`

### Notes
If receipt write cannot be simulated without on-chain side effects, the shadow artifact must still record:
- what receipt PDA would be targeted
- whether receipt config is valid
- whether the receipt step is considered structurally buildable

Receipt identity for shadow mode may come from either:
- cluster manifest (`deployments/mainnet/receipt.json` by default, or `RECEIPT_MANIFEST_PATH`)
- complete explicit config fallback identity

Manifest identity is preferred when present.

## E) Trigger-quality observation
Shadow mode must produce evidence on whether policy behavior is sensible.

### Metrics to compute
At minimum:
- number of monitored evaluations
- number of triggers fired
- number of triggers suppressed by debounce
- number of candidate tx builds attempted
- number of successful simulations
- number of failed simulations by error class
- average quote age at trigger
- average time from first out-of-range sample to trigger
- number of up triggers vs down triggers

### Optional but high-value
- track whether price re-entered the original range within a configurable window after trigger
- track max adverse move avoided vs missed continuation after trigger
- track “fakeout” count per direction

This is observational only. It does not alter policy behavior in M19.

## F) Safety and enforcement
Shadow mode must be impossible to mistake for live mode.

### Requirements
- UI and logs must clearly indicate `MAINNET SHADOW MODE`
- No signing prompt should ever be generated
- No transaction send function may be reachable from the shadow workflow
- Any code path that attempts live execution in shadow mode must fail closed

### Acceptance invariant
A full shadow-mode run on mainnet must result in:
- zero mainnet transactions sent by the autopilot
- zero on-chain state changes caused by the autopilot

## G) Config and cluster rules
Update config to support mainnet shadow mode:

### Required config
- `cluster = "mainnet"`
- `executionMode = "mainnet-shadow"`
- `swapRouter = "jupiter"` by default on mainnet
- receipt identity must be resolvable at startup, via either:
  - checked-in mainnet manifest (`deployments/mainnet/receipt.json`)
  - `RECEIPT_MANIFEST_PATH`
  - complete receipt identity fields in config
- dry-run / send-disabled flag must not be optional if `executionMode=mainnet-shadow`

### Validation rules
- `mainnet-shadow + swapRouter=noop` is allowed only for specific diagnostic runs; default remains `jupiter`
- `mainnet-shadow + sendEnabled=true` must fail config validation
- shadow startup must resolve receipt identity before entering the monitor loop
- shadow startup must verify the configured/manifested receipt program on-chain before monitoring positions
- if mainnet receipt identity is missing or not resolvable, fail fast with canonical error:
  - `RECEIPT_CONFIG_INCOMPLETE_FOR_SHADOW`
- if the manifest/config points at a bad IDL artifact or hash, fail fast before monitoring
- if receipt program verification fails, fail fast before monitoring rather than looping with per-position retries

## H) Operator workflow
Provide a runbook for operating shadow mode in production-like conditions.

### Runbook must include
- required env vars
- receipt identity source selection (`deployments/mainnet/receipt.json`, `RECEIPT_MANIFEST_PATH`, or explicit config fallback)
- RPC requirements
- how to start monitoring
- how to inspect current shadow artifacts
- how to read simulation failures
- how to distinguish:
  - strategy trigger issue
  - quote issue
  - tx builder issue
  - RPC issue
  - Token-2022 issue
  - receipt config issue
- how to stop the shadow process safely
- how to interpret startup-class receipt failures versus per-position evaluation failures

## I) Testing

### Unit tests
- config validation:
  - `mainnet-shadow` rejects send-enabled config
  - `mainnet-shadow` rejects live send path
  - mainnet manifest/config receipt identity resolution behaves deterministically
- artifact creation:
  - triggered decision produces persistent artifact
  - non-trigger evaluation records minimal artifact or metric entry per design
- simulation result mapping:
  - raw simulation errors map to canonical codes

### Integration tests
- builder path in shadow mode uses the same tx construction as live mode
- shadow mode never invokes the signer/send function
- triggered decision persists artifact even when simulation fails
- runner aborts startup on fatal receipt identity / receipt verification failures
- `executeOnce()` startup-class `ERROR` results are surfaced, not silently skipped

### Manual/mainnet acceptance run
A manual shadow run on mainnet must demonstrate:
- monitoring of at least one real position
- at least one complete trigger evaluation artifact
- at least one candidate tx simulation attempt
- proof that no send occurred
- successful receipt identity resolution from the intended mainnet manifest or explicit config fallback

## Deliverables
- `executionMode` support with enforced `mainnet-shadow`
- shadow-run artifact schema and persistence implementation
- mainnet shadow pipeline wiring
- simulation classification and reporting
- operator runbook for mainnet shadow mode
- tests covering config safety, artifact generation, and send-path prohibition

## Acceptance criteria (Definition of Done)
- The system can monitor real mainnet positions in `mainnet-shadow` without sending any transactions.
- Triggered events produce persistent structured artifacts.
- Candidate exit transactions can be built and simulated on mainnet.
- Simulation results are classified into canonical error/success categories.
- The send/sign path is technically unreachable in shadow mode.
- The runner fails fast on startup-class receipt identity / verification errors instead of silently looping.
- Operators can run shadow mode, inspect outputs, and diagnose failures using the runbook.
- A multi-day shadow run yields analyzable evidence about trigger quality and tx/simulation reliability.

## Exit criteria for promoting to M20
M19 is only complete when shadow mode provides enough evidence to decide whether live mainnet execution should be enabled.

Minimum promotion thresholds should be defined and met, such as:
- sustained shadow run duration achieved
- acceptable simulation success rate
- no unexplained duplicate-trigger anomalies
- no uncontrolled Token-2022 account failures
- no config drift between intended and observed mainnet behavior

Until those thresholds are met, mainnet live execution remains blocked.
