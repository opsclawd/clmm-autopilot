# Production Readiness Checklist (M18)

Use this checklist before allowing `execute` mode in a production-like environment.

## Config

- `cluster` is correct for the target environment
- `rpcUrl` resolves to the intended cluster
- `operator.runtimeMode` is explicitly reviewed
- `operator.executionPausedDefault` is intentionally set
- `execution.swapRouter` is explicitly reviewed
- mainnet does not use `noop`
- receipt identity fields are configured when execute mode is required outside devnet

## Operator State

- effective paused state is `false`
- session override is cleared or explicitly documented
- web/mobile shell shows the expected runtime mode
- web/mobile shell shows the expected paused state

## Execution Safety

- wallet/provider is connected and signing-capable
- simulation succeeds for a representative trigger path
- duplicate execution is blocked for the same canonical epoch
- token/token-2022 path is verified for the target pair

## Observability

- structured JSON event output is present
- canonical event envelope fields are populated
- counter snapshot is readable
- snapshot/build/simulation/send counters change as expected
- operator-facing failures map to stable canonical codes

## Runbook Verification

- startup validation flow is understood by the operator
- failure-family actions in `docs/runbook.md` were checked during a clean rehearsal
- a second operator can reproduce the workflow from docs alone
