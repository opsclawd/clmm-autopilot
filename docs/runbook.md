# Operator Runbook (M18-M19)

## Commands

```bash
pnpm install
pnpm -r test
pnpm receipt:build
pnpm receipt:check:devnet
pnpm receipt:check:mainnet -- --rpc-url <RPC_URL>
pnpm receipt:local -- --db-path <PATH> [--authority <PUBKEY>] [--position-mint <PUBKEY>] [--position-address <PUBKEY>] [--epoch <UNIX_DAY>] [--status pending|confirmed|failed]
pnpm e2e:devnet
pnpm e2e:certify:devnet
pnpm shadow:mainnet
```

Deploy/update devnet receipt program identity (manual acceptance workflow):

```bash
pnpm receipt:deploy:devnet
```

Devnet receipt deploy expects a fixed program keypair via `RECEIPT_PROGRAM_KEYPAIR` (or `--program-keypair`) and uses `solana program deploy --program-id ...` instead of mutating source files after deployment.

Mainnet receipt release workflow:

```bash
pnpm receipt:deploy:mainnet -- --dry-run --rpc-url <RPC_URL> --program-keypair <PROGRAM_KEYPAIR> --expected-upgrade-authority <MULTISIG_PUBKEY>
pnpm receipt:deploy:mainnet -- --rpc-url <RPC_URL> --program-keypair <PROGRAM_KEYPAIR> --expected-upgrade-authority <MULTISIG_PUBKEY>
pnpm receipt:check:mainnet -- --rpc-url <RPC_URL>
```

See `docs/release-receipt-mainnet.md` for the full `m20` release sequence and retained artifacts.

Harness env vars:

- `RPC_URL` (required)
- `AUTHORITY_KEYPAIR` (required, dev-only local keypair JSON path)
- `LOCAL_RECEIPT_DB_PATH` (required; SQLite path used for local duplicate protection)
- `ONCHAIN_RECEIPT_ENABLED` (optional: `1|0|true|false`, default `1` on devnet harness)
- `POSITION_ADDRESS` (optional when direction-specific candidate inventories are set; exact devnet position account)
- `POSITION_ADDRESS_CANDIDATES_DOWN` (preferred for certification; comma-separated devnet candidates for `DOWN` trigger fixtures)
- `POSITION_ADDRESS_CANDIDATES_UP` (preferred for certification; comma-separated devnet candidates for `UP` trigger fixtures)
- `POSITION_ADDRESS_CANDIDATES` (legacy fallback list; retained for ad hoc harness runs)
- `SWAP_ROUTER` (optional: `noop` | `orca` | `jupiter`, default `noop` for deterministic harness runs)
- `FORCE_DECISION` (optional: `TRIGGER_DOWN` | `TRIGGER_UP`; overrides live policy decision to force receipt proof path)
- `REQUIRE_RECEIPT_PROOF` (optional: `1|0|true|false`, default `0`; when enabled, `HOLD` is treated as failure)
- `TOKEN2022_POSITION_ADDRESS` (optional; non-blocking check: when set, harness logs whether that position resolves to a Token-2022 pool and never fails the main run if unavailable/mismatched)
- `RECEIPT_IDENTITY_SOURCE` (optional, advanced: set to `config` to force legacy config fallback identity instead of devnet manifest)

App/runtime operator config:

- `executionMode` (`devnet-live` | `mainnet-shadow` | `mainnet-live`)
- `operator.runtimeMode` (`dry-run` | `simulate-only` | `execute`) (legacy compatibility)
- `operator.executionPausedDefault` (`true` | `false`)
- `execution.localReceiptDbPath` (explicit SQLite path for live duplicate protection)
- `execution.onChainReceiptEnabled` (`true` | `false`)
- `execution.localReceiptClaimTtlMs` (stale pending-claim recovery window)

Pause precedence:

1. session override
2. config default

Effective paused state is always derived as `sessionOverride ?? executionPausedDefault`.

## Runtime Modes

Execution mode is now the primary operator control:

- `devnet-live`
  - legacy-compatible behavior on devnet/localnet
  - uses runtimeMode for dry-run/simulate-only/execute in existing shells
- `mainnet-shadow`
  - full decision/build/sim path on mainnet
  - send path is structurally blocked by `ShadowSubmitter`
  - receipt ix is omitted from simulated candidate tx
  - on-chain receipts must stay disabled
- `mainnet-live`
  - full live path on mainnet
  - requires explicit local receipt DB config and send-enabled execution

- `dry-run`
  - evaluates monitoring + policy only
  - no tx build, no simulation, no send
  - `executeOnce()` returns an operator-blocked error if called directly
- `simulate-only`
  - evaluates, builds, and simulates
  - never requests signature or sends a tx
  - safe default for devnet shells
- `execute`
  - full send path
  - requires wallet/provider, valid receipt identity, supported router/cluster, and unpaused operator state

Safe defaults:

- `devnet`: `simulate-only`
- `mainnet`: `mainnet-shadow` + `simulate-only`
- `localnet`: `dry-run`

Mainnet guardrails:

- no silent `noop` router fallback
- mainnet shadow defaults to `jupiter`; `noop` allowed only with explicit diagnostics override
- execute requires explicit operator config
- execute requires explicit `execution.localReceiptDbPath`
- receipt identity is required only when `execution.onChainReceiptEnabled=true`
- any send attempt in shadow mode fails with `EXECUTION_MODE_SEND_FORBIDDEN`
- `mainnet-shadow` rejects `execution.onChainReceiptEnabled=true`

## Mainnet Shadow Runner (M19)

Start command:

```bash
pnpm shadow:mainnet
```

Required env/config:

- `SOLANA_RPC_URL` (or `RPC_URL`)
- `SHADOW_AUTHORITY` (or `AUTHORITY_PUBKEY`)
- `SHADOW_POSITION_ADDRESSES` (default source mode: configured list)
- `SHADOW_DISCOVER_POSITIONS=true` to opt into discovery when no configured list is provided
- local receipt storage is configured through `SHADOW_AUTOPILOT_CONFIG` / `AUTOPILOT_CONFIG` or `SHADOW_AUTOPILOT_CONFIG_PATH` / `AUTOPILOT_CONFIG_PATH`:
  - inline JSON env takes precedence when both inline JSON and config path are set
  - relative config paths resolve from the repo root
  - set `execution.localReceiptDbPath` explicitly for any live send path
  - on mainnet shadow, local receipt reads are optional and on-chain receipts remain disabled
- optional `SHADOW_DB_PATH` (default: `artifacts/shadow/mainnet/shadow.db`; relative paths resolve from the repo root)
- optional `SHADOW_ROLLUP_EVERY_EVALS` (default: `50`)

Startup behavior:

- the runner prints the local receipt DB path and on-chain toggle state at startup
- when on-chain receipts are disabled, duplicate protection is limited to processes sharing the same SQLite file
- startup-class config/runtime failures stop the process immediately instead of being retried forever

Storage:

- `shadow_evaluations`: sparse state-change/sampled evaluation records
- `shadow_triggers`: full trigger artifacts (quote/build/sim/receipt planning)
- `shadow_metrics_rollups`: periodic aggregate metrics and safety counter snapshots

Cold-start semantics:

- restart resets in-memory debounce/policy state
- run session + first per-position evaluation are marked `stateColdStart=true`

Position source modes:

- `configured` (default)
- `discovered` (explicit opt-in only)

## Startup Validation

Validation is layered:

1. config normalization in `@clmm-autopilot/core`
2. static config validation for operator/runtime safety
3. runtime environment validation for RPC URL and execute prerequisites
4. authoritative execution gate in the Solana runtime

The Solana runtime gate is the safety boundary. UI disablement is advisory only.

Gate order:

1. runtime mode
2. effective paused state
3. wallet/provider presence
4. local receipt DB presence for live execution
5. receipt identity presence when on-chain receipts are enabled
5. router/cluster compatibility

Example:

```bash
set -a
source .env
set +a
pnpm receipt:check:devnet
pnpm e2e:devnet
```

To generate a reusable candidate list from a wallet before running the harness:

```bash
node scripts/find-devnet-whirlpool-positions.mjs --wallet "$WALLET_ADDRESS"
```

## What `pnpm e2e:devnet` does

0. Uses `LOCAL_RECEIPT_DB_PATH` as the authoritative local receipt ledger for duplicate protection
1. When `ONCHAIN_RECEIPT_ENABLED=1`, resolves receipt identity from `deployments/devnet/receipt.json` (manifest is source of truth on devnet unless explicitly overridden with `RECEIPT_IDENTITY_SOURCE=config`)
2. When `ONCHAIN_RECEIPT_ENABLED=1`, verifies the receipt program account exists + executable + upgradeable-loader owner
3. Fetches position snapshot from devnet
4. Enforces SOL/USDC guardrail (`NOT_SOL_USDC` on mismatch)
5. Evaluates policy decision from canonical tick samples
6. Optionally overrides decision when `FORCE_DECISION` is configured
7. If HOLD:
   - exits `0` when `REQUIRE_RECEIPT_PROOF` is unset/false
   - fails fast when `REQUIRE_RECEIPT_PROOF=1`
8. If TRIGGER: checks the local receipt ledger pre-state (must be clear)
   - when candidate inventories are set, the harness first records deterministic exclusion reasons and then selects the first matching fixture for the requested direction/scenario
9. If swap is planned and router is not `noop`, fetches swap quote via configured adapter (`execution.swapRouter`) and computes canonical attestation payload/hash
10. Builds tx + simulates (simulation gate)
11. Claims the local receipt ledger and sends + confirms
12. When `ONCHAIN_RECEIPT_ENABLED=1`, checks canonical receipt PDA post-state (must be `count=1`) and verifies:
    - authority
    - position_mint
    - epoch
    - direction
    - stored hash equals local attestation hash
13. When `ONCHAIN_RECEIPT_ENABLED=0`, checks the local receipt ledger for a confirmed row instead of an on-chain PDA
14. Executes the same flow a second time in the same epoch and requires deterministic rejection with `ALREADY_EXECUTED_THIS_EPOCH`

## Local Receipt Recovery

- Stale `pending` claims recover automatically by TTL takeover using `execution.localReceiptClaimTtlMs`
- Failed executions are recorded as `failed` with error metadata and can be retried safely
- Mid-epoch cutover from on-chain receipts to SQLite-only mode is unsupported in this rollout unless the local ledger was already seeded for that epoch

Logs are JSON (structured) and failure exits non-zero.

## Structured Events and Counters

Runtime event envelope fields:

- `event`
- `timestamp`
- `cluster`
- `executionMode`
- `runtimeMode`
- `executionPaused`
- `authority`
- `position`
- `whirlpool`
- `router`
- `direction`
- `correlationId`
- `status`
- `errorCode`
- `details`

Core event names include:

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

Counters are in-memory and scoped per process/app session. They reset on process restart or app reload.

Shadow safety counters (must remain zero in M19 runs):

- `signerInvocations`
- `submitInvocations`
- `walletPromptCount`
- `shadowTxSignaturesEmitted`

## M19 Promotion Thresholds (Balanced)

Promotion from M19 to M20 readiness review requires:

- runtime duration >= 10 consecutive days
- simulation success rate >= 85% (`SIM_OK / total_trigger_candidates`)
- quote staleness failure rate <= 8% (`SIM_QUOTE_STALE / total_trigger_candidates`)
- zero unexplained drift for all 4 shadow safety counters
- unresolved `SIM_TOKEN2022_ACCOUNT_MISMATCH` count <= 1

Any threshold breach resets the promotion window after remediation.

## Certification suite

`pnpm e2e:certify:devnet` runs named certification scenarios and writes one canonical artifact per scenario to:

- default: `artifacts/e2e/devnet/<scenario>/<runId>.json`
- override: set `E2E_ARTIFACT_DIR`

Run one named scenario by setting `E2E_CERT_SCENARIO`, for example:

```bash
E2E_CERT_SCENARIO=hold-path-debounce E2E_CERT_DIRECTION=DOWN pnpm e2e:certify:devnet
```

Supported scenario names are:

- `happy-path-execute`
- `hold-path-debounce`
- `stale-quote-rebuild`
- `signing-delay-blockhash-drift`
- `rpc-retry-exhaustion`
- `unsupported-router-cluster`
- `unsupported-swap-route`
- `insufficient-fee-buffer`
- `slippage-cap-breach`
- `duplicate-execution-same-epoch`
- `local-receipt-pending-blocker`
- `local-receipt-failed-retry`

Direction filters:

- `E2E_CERT_DIRECTION=DOWN|UP`
- if no direction is provided, the full direction x scenario matrix runs

Artifact status values:

- `PASS`
- `HOLD`
- `EXPECTED_FAILURE`
- `SKIPPED`
- `FAIL`

Artifacts include `schemaVersion: 2` and should be used as the primary certification record (logs remain supplementary).
When `status=SKIPPED`, the artifact also includes a stable top-level `skipReason`.

## Consistency guard

`pnpm receipt:check:devnet` is mandatory before harness/manual workflow. It asserts:

1. `programs/receipt/src/lib.rs` `declare_id!()` equals the manifest `programId`
2. `Anchor.toml` `[programs.devnet].receipt` equals the manifest `programId`
3. Runtime resolver identity equals manifest identity (`programId`, `idlHashMode`, `idlHash`, `idlPath`)
4. `receipt.idl.json.address` equals the resolved/manifests `programId`
5. `idlPath` exists on disk

If this fails, do not run harness until manifest/IDL drift is fixed.

`pnpm receipt:check:mainnet -- --rpc-url <RPC_URL>` is mandatory after a mainnet release. It additionally asserts:

1. `programBinarySha256` matches the retained `programBinaryPath`
2. pinned Anchor/Solana/`solana-verify` versions are recorded in the manifest
3. `solana-verify` local executable hash equals the on-chain program hash
4. the observed upgrade authority matches the expected multisig
5. retained verify evidence exists on disk

## Deploy flow details

`pnpm receipt:deploy:devnet` runs:

1. `anchor build`
2. Validates fixed identity across `declare_id!`, `Anchor.toml`, the supplied program keypair, and the built IDL address
3. Deploys with `solana program deploy ... --program-id <PROGRAM_KEYPAIR> --url <RPC_URL> --keypair <WALLET>`
4. Copies `target/idl/receipt.json` to `deployments/devnet/receipt.idl.json`
5. Computes `full-v1` IDL hash
6. Atomically writes `deployments/devnet/receipt.json`
7. Runs consistency guard

`pnpm receipt:deploy:mainnet` runs:

1. `cd programs/receipt && anchor build --verifiable`
2. Validates fixed identity across source, Anchor config, program keypair, and built IDL
3. Computes the retained `.so` SHA-256 and deploy-cost preflight
4. Deploys the verifiable-build `.so` with `solana program deploy ... --program-id <PROGRAM_KEYPAIR> --url <RPC_URL> --keypair <WALLET>`
5. Transfers upgrade authority with `solana program set-upgrade-authority <PROGRAM_ID> --new-upgrade-authority <MULTISIG> --skip-new-upgrade-authority-signer-check`
6. Copies the retained IDL and `.so` to `deployments/mainnet/`
7. Runs `solana-verify get-executable-hash` and `solana-verify get-program-hash`
8. Atomically writes:
   - `deployments/mainnet/receipt.json`
   - `deployments/mainnet/receipt.provenance.json`
   - `deployments/mainnet/receipt.verify.json`
9. Runs the mainnet consistency guard before release artifacts are published

## Failure → Action mapping

- `QUOTE_STALE`
  - **Cause:** Quote aged past freshness window.
  - **Action:** Re-fetch snapshot + quote and rerun command immediately.

- `moved price / rebuild required`
  - **Cause:** Tick drift exceeded rebuild threshold between quote and send path.
  - **Action:** Rebuild using a fresh quote (rerun harness); do not widen slippage cap.

- `BLOCKHASH_EXPIRED`
  - **Cause:** Blockhash not valid by send time.
  - **Action:** Rerun command; blockhash refresh + bounded retry is already enforced.

- `INSUFFICIENT_FEE_BUFFER`
  - **Cause:** Wallet balance cannot cover rent + tx fee + priority fee + fixed buffer.
  - **Action:** Fund authority wallet with more SOL, then rerun.

- `ALREADY_EXECUTED_THIS_EPOCH`
  - **Cause:** Receipt PDA already exists for `(position_mint, authority, unixDays)`.
  - **Action:** Do not retry in same UTC day epoch; wait for next epoch/day or use a different position.

- `RECEIPT_PROGRAM_NOT_CONFIGURED`
  - **Cause:** Mainnet/devnet receipt manifest could not be resolved, `RECEIPT_MANIFEST_PATH` points at a bad file, or forced config fallback identity is incomplete.
  - **Action:** Prefer a valid manifest (`deployments/<cluster>/receipt.json` or `RECEIPT_MANIFEST_PATH`) or provide complete config fallback fields.

- `RECEIPT_IDL_MISMATCH`
  - **Cause:** Runtime `full-v1` hash of the referenced IDL artifact differs from configured hash, or the manifest/config points at the wrong IDL path.
  - **Action:** Refresh the manifest + IDL atomically and verify the referenced `idlPath` matches the intended cluster deployment.

- `RECEIPT_PROGRAM_VERIFICATION_FAILED`
  - **Cause:** Program missing, non-executable, wrong owner, strict authority mismatch, or `HOLD` while `REQUIRE_RECEIPT_PROOF=1`.
  - **Action:** Verify `solana program show`, confirm manifest program id, reconcile optional `expectedUpgradeAuthority`, and if needed set `FORCE_DECISION` or use a trigger-eligible position.

- `dust swap skipped`
  - **Cause:** Swap amount below configured dust threshold.
  - **Action:** Expected behavior. Execution may still complete with swap intentionally skipped.

- `NOT_SOL_USDC`
  - **Cause:** Position is not the canonical SOL/USDC pair.
  - **Action:** Use a SOL/USDC position only.

- `RECEIPT_MISMATCH`
  - **Cause:** Confirmed receipt fields/hash differ from locally computed expectations.
  - **Action:** Stop automation for this position, inspect tx + receipt PDA on explorer, and rerun with fresh quote once mismatch root cause is understood.

## Spec Traceability

See `docs/spec-traceability.md` for milestone-by-milestone status (`met`, `partial`, `deferred`) and the corresponding code/tests.
