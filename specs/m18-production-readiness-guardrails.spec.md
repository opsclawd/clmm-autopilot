# M18 — Production readiness guardrails (config, safety, observability, kill switches)

## Goal
Harden the MVP so it can run in a production-like environment without relying on implicit defaults, fragile operator behavior, or silent unsafe execution. This milestone adds strict runtime validation, safe execution guardrails, structured observability, and operator control surfaces.

## Non-goals
- Background auto-execution service.
- Portfolio-level orchestration across many positions.
- Advanced analytics or PnL reporting.
- New trading logic or policy rules beyond guardrails around the existing policy/execution path.

## Scope

### In scope
1) Strict config and environment validation at startup
2) Safe runtime execution modes (`dry-run`, `simulate-only`, `execute`)
3) Kill switch / pause controls
4) Structured logs and canonical event taxonomy
5) Canonical metrics / counters for operator visibility
6) Safer defaults for mainnet and devnet
7) Failure classification and operator-facing error surfaces
8) Release checklist + operator runbook updates

### Out of scope
- Push notification infrastructure
- PagerDuty/Sentry/Datadog integration beyond interfaces or minimal adapters
- Auto-remediation or self-healing orchestration
- Multi-tenant auth or role-based access control

## Requirements

## A) Strict config validation (fail fast)
Add a single startup validator for all runtime config.

### Required config groups
- `cluster`
- `rpcUrl`
- `swapRouter`
- `receiptProgramId`
- `receiptIdl` / `receiptIdlHash` (if introduced earlier)
- `policy`:
  - `cadenceMs`
  - `requiredConsecutive`
  - `cooldownMs`
- `execution`:
  - `slippageBpsCap`
  - `feeBufferLamports`
  - `quoteFreshnessSec`
  - `quoteFreshnessSlots`
  - `maxRetries`
  - `minSolLamportsToSwap`
  - `minUsdcMinorToSwap`
  - `swapRouter`
- operator mode:
  - `runtimeMode = "dry-run" | "simulate-only" | "execute"`

### Validation rules
- No missing required fields.
- No impossible numeric values:
  - `slippageBpsCap > 0`
  - `requiredConsecutive >= 1`
  - `cadenceMs > 0`
  - `cooldownMs >= 0`
  - `maxRetries >= 0`
- Cluster/router compatibility must be enforced.
- Receipt config must be present when runtime mode can execute.
- Mainnet must not boot with unsafe defaults (see section F).

### Canonical errors
Add typed startup errors such as:
- `CONFIG_INVALID`
- `RPC_URL_MISSING`
- `SWAP_ROUTER_UNSUPPORTED_CLUSTER`
- `RECEIPT_PROGRAM_NOT_CONFIGURED`
- `RUNTIME_MODE_INVALID`

## B) Runtime modes (explicit, enforced)
The system must support exactly three operator modes:

### 1) `dry-run`
- Monitor + evaluate policy only
- No tx build
- No simulation
- No signing/execution
- Emits hypothetical decision events only

### 2) `simulate-only`
- Monitor + evaluate
- Build tx if triggerable
- Simulate only
- Never request wallet signature
- Emits simulation result and hypothetical postconditions

### 3) `execute`
- Full path enabled
- Requires valid receipt config, supported router, and explicit operator action

### Rules
- Mode must be displayed in UI and logs.
- Mode must be included in every execution event payload.
- Execution paths must hard-block when mode does not allow them.

## C) Kill switch / pause controls
Add an explicit operator-controlled kill switch.

### Required behavior
- Global execution pause:
  - monitoring may continue
  - execution must hard-block
- Optional finer-grained pause flags:
  - pause all swaps
  - pause all receipt writes
  - pause all tx builds

### Minimum implementation
At minimum support:
- `executionPaused: boolean`

### Rules
- If paused, UI must show paused state clearly.
- Builder/executor must fail fast with canonical error:
  - `EXECUTION_PAUSED`
- Pause state must be included in structured logs/events.

## D) Structured logging and event taxonomy
Replace ad hoc console noise with structured event records.

### Required event categories
- `monitor.snapshot_fetched`
- `monitor.snapshot_failed`
- `policy.decision_hold`
- `policy.decision_trigger_up`
- `policy.decision_trigger_down`
- `policy.cooldown_active`
- `execution.build_started`
- `execution.build_failed`
- `execution.simulation_started`
- `execution.simulation_failed`
- `execution.send_started`
- `execution.send_confirmed`
- `execution.send_failed`
- `execution.receipt_precheck_zero`
- `execution.receipt_precheck_exists`
- `execution.receipt_verified`
- `execution.swap_skipped_dust`
- `execution.paused_block`
- `config.validation_failed`

### Required fields on every log/event
- timestamp
- cluster
- runtimeMode
- wallet/authority pubkey (if available)
- position pubkey (if applicable)
- whirlpool pubkey (if applicable)
- router
- direction (if applicable)
- error code (if failure)
- correlation id / execution id

### Rules
- Use structured JSON output in runtime paths.
- Avoid free-form string parsing as the only observability mechanism.

## E) Metrics / counters
Add a minimal internal metrics surface or counters module.

### Required counters
- snapshots fetched
- snapshot failures
- trigger up count
- trigger down count
- build attempts
- build failures
- simulation attempts
- simulation failures
- send attempts
- send confirmations
- send failures
- receipt exists precheck count
- receipt written count
- swap skipped count
- paused blocks
- config validation failures

### Minimum requirement
- Metrics can be in-memory and logged periodically for MVP.
- Interface should be structured so it can later back Prometheus/OpenTelemetry/etc.

## F) Safer defaults
Mainnet and devnet must not share dangerous defaults.

### Devnet defaults
- `runtimeMode = "simulate-only"` or explicit local override required for execute
- `swapRouter = "orca"` or `"noop"` based on current harness strategy
- lower fee buffer acceptable for test environment

### Mainnet defaults
- `runtimeMode = "dry-run"`
- execute must require explicit override
- `swapRouter = "jupiter"` only if supported and configured
- conservative fee buffer
- conservative quote freshness / retries
- receipt program must be configured
- no silent fallback to noop router

### Rules
- Mainnet execute must never happen because of an implicit default.
- Unsafe defaults must be rejected by validation.

## G) Failure classification and UI/operator surfacing
Map internal errors into stable categories.

### Required categories
- config failure
- rpc/network failure
- quote/router failure
- simulation failure
- chain rejection
- receipt/idempotency failure
- token-program/account mismatch
- paused/operator block

### Deliverables
- Canonical error mapper
- UI-facing status mapping for operator console
- Runbook section for each failure family

## H) Secrets and operator hygiene
Formalize minimal operator safety practices.

### Requirements
- No private keys committed in repo
- No fallback dev wallet silently generated in execute mode
- Wallet source must be explicit in docs/runtime
- Sensitive values must never be printed in logs beyond public keys

### Minimum validation
- If execute mode is enabled without a real wallet/provider, fail fast

## I) Release checklist
Add a production-readiness checklist document.

### Required checklist items
- config validated
- correct cluster selected
- correct router selected
- receipt program configured
- receipt idl/hash validated
- runtime mode confirmed
- paused state confirmed false
- simulation passes for representative trigger
- duplicate execution blocked in same epoch
- structured logs present
- metrics counters increment as expected
- token/token2022 path tested for target pair
- runbook steps verified by a second clean run

## Tests

### Unit tests
- config validator rejects missing/unsafe values
- runtime mode blocks prohibited operations
- paused state blocks execution
- event logger emits required fields
- metrics counters increment deterministically

### Integration tests
- execute path blocked in `dry-run`
- send blocked in `simulate-only`
- paused execute path returns `EXECUTION_PAUSED`
- mainnet config with implicit execute rejected
- structured execution lifecycle emits expected event sequence

### Devnet/manual verification
- boot in `dry-run`, `simulate-only`, and `execute`
- verify logs and UI show correct mode
- verify pause blocks execution without disabling monitoring
- verify receipt path still works in execute mode
- verify metrics/log output is usable for triage

## Deliverables
- startup config validator
- runtime mode enforcement
- kill switch / pause control
- structured logging module + event taxonomy
- metrics/counters module
- updated UI/operator surfaces for mode + pause + classified failures
- release checklist document
- updated operator runbook

## Acceptance criteria (Definition of Done)
- App fails fast on invalid or unsafe config before runtime monitoring starts.
- Runtime modes are enforced and visible.
- Pause control blocks execution deterministically.
- Execution lifecycle emits structured events with required fields.
- Metrics/counters exist for core lifecycle events.
- Mainnet defaults are safe and require explicit opt-in for execution.
- Tests pass and operator runbook accurately reflects real startup and failure behavior.