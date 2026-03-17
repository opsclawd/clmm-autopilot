# Production Readiness Checklist (M18-M20)

Use this checklist before allowing `execute` mode in a production-like environment.

## Config

- `cluster` is correct for the target environment
- `rpcUrl` resolves to the intended cluster
- `Anchor.toml` pins `anchor_version=0.32.1` and `solana_version=2.3.0`
- `solana-verify` 0.4.12 is installed and documented in the release environment
- `executionMode` is explicitly reviewed
- `operator.runtimeMode` is explicitly reviewed
- `operator.executionPausedDefault` is intentionally set
- `execution.swapRouter` is explicitly reviewed
- mainnet does not use `noop`
- `mainnet-shadow` has `execution.sendEnabled=false`
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
- for shadow runs: `signerInvocations=0`, `submitInvocations=0`, `walletPromptCount=0`, `shadowTxSignaturesEmitted=0`

## M20 Release Gates

- `pnpm receipt:deploy:mainnet -- --dry-run --rpc-url <RPC> --program-keypair <KEYPAIR> --expected-upgrade-authority <MULTISIG>` succeeds
- verifiable build runs from `programs/receipt/`
- deploy-cost preflight passes for the retained `.so` size and deployer balance
- release flow transfers upgrade authority to the expected multisig before final artifact publication
- `pnpm receipt:check:mainnet -- --rpc-url <RPC>` succeeds
- canonical retained outputs are preserved under release control:
  - `deployments/mainnet/receipt.json`
  - `deployments/mainnet/receipt.idl.json`
  - provenance record / verify evidence
  - release notes / commit reference

## M19 Promotion Gates

- >= 10 consecutive shadow-mode runtime days
- >= 85% trigger-candidate simulation success rate
- <= 8% trigger-candidate quote staleness failure rate
- unresolved `SIM_TOKEN2022_ACCOUNT_MISMATCH` count <= 1

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
