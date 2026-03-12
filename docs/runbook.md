# Operator Runbook (M15)

## Commands

```bash
pnpm install
pnpm -r test
pnpm receipt:check:devnet
pnpm e2e:devnet
pnpm e2e:certify:devnet
```

Deploy/update devnet receipt program identity (manual acceptance workflow):

```bash
pnpm receipt:deploy:devnet
```

Harness env vars:

- `RPC_URL` (required)
- `AUTHORITY_KEYPAIR` (required, dev-only local keypair JSON path)
- `POSITION_ADDRESS` (optional when `POSITION_ADDRESS_CANDIDATES` is set; exact devnet position account)
- `POSITION_ADDRESS_CANDIDATES` (optional comma-separated fallback list; harness picks the first SOL/USDC candidate without a receipt for the current UTC-day epoch)
- `SWAP_ROUTER` (optional: `noop` | `orca` | `jupiter`, default `noop` for deterministic harness runs)
- `FORCE_DECISION` (optional: `TRIGGER_DOWN` | `TRIGGER_UP`; overrides live policy decision to force receipt proof path)
- `REQUIRE_RECEIPT_PROOF` (optional: `1|0|true|false`, default `0`; when enabled, `HOLD` is treated as failure)
- `TOKEN2022_POSITION_ADDRESS` (optional; non-blocking check: when set, harness logs whether that position resolves to a Token-2022 pool and never fails the main run if unavailable/mismatched)
- `RECEIPT_IDENTITY_SOURCE` (optional, advanced: set to `config` to force legacy config fallback identity instead of devnet manifest)

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

0. Resolves receipt identity from `deployments/devnet/receipt.json` (manifest is source of truth on devnet unless explicitly overridden with `RECEIPT_IDENTITY_SOURCE=config`)
1. Verifies receipt program account exists + executable + upgradeable-loader owner
2. If `expectedUpgradeAuthority` is set in manifest, enforces strict authority match
3. Fetches position snapshot from devnet
4. Enforces SOL/USDC guardrail (`NOT_SOL_USDC` on mismatch)
5. Evaluates policy decision from canonical tick samples
6. Optionally overrides decision when `FORCE_DECISION` is configured
7. If HOLD:
   - exits `0` when `REQUIRE_RECEIPT_PROOF` is unset/false
   - fails fast when `REQUIRE_RECEIPT_PROOF=1`
8. If TRIGGER: checks canonical receipt PDA pre-state (must be `count=0`)
   - when `POSITION_ADDRESS_CANDIDATES` is set, the harness first skips candidates that already have a receipt for the current epoch
9. If swap is planned and router is not `noop`, fetches swap quote via configured adapter (`execution.swapRouter`) and computes canonical attestation payload/hash
10. Builds tx + simulates (simulation gate)
11. Sends + confirms
12. Checks canonical receipt PDA post-state (must be `count=1`) and verifies:
    - authority
    - position_mint
    - epoch
    - direction
    - stored hash equals local attestation hash
13. Executes the same flow a second time in the same epoch and requires deterministic rejection with `ALREADY_EXECUTED_THIS_EPOCH`

Logs are JSON (structured) and failure exits non-zero.

## Certification suite

`pnpm e2e:certify:devnet` runs named certification scenarios and writes one canonical artifact per scenario to:

- default: `artifacts/e2e/devnet/<scenario>/<runId>.json`
- override: set `E2E_ARTIFACT_DIR`

Artifact status values:

- `PASS`
- `HOLD`
- `EXPECTED_FAILURE`
- `SKIPPED`
- `FAIL`

Artifacts include `schemaVersion: 1` and should be used as the primary certification record (logs remain supplementary).

## Consistency guard

`pnpm receipt:check:devnet` is mandatory before harness/manual workflow. It asserts:

1. `programs/receipt/src/lib.rs` `declare_id!()` equals the manifest `programId`
2. `Anchor.toml` `[programs.devnet].receipt` equals the manifest `programId`
3. Runtime resolver identity equals manifest identity (`programId`, `idlHashMode`, `idlHash`, `idlPath`)
4. `receipt.idl.json.address` equals the resolved/manifests `programId`
5. `idlPath` exists on disk

If this fails, do not run harness until manifest/IDL drift is fixed.

## Deploy flow details

`pnpm receipt:deploy:devnet` runs:

1. `anchor build`
2. `anchor deploy --provider.cluster devnet`
3. Syncs `declare_id!()` and `Anchor.toml` to the deployed program id
4. Re-runs `anchor build` so committed IDL/artifacts embed the deployed program id
5. Copies `target/idl/receipt.json` to `deployments/devnet/receipt.idl.json`
6. Computes `full-v1` IDL hash
7. Atomically writes `deployments/devnet/receipt.json`
8. Verifies with `solana program show <PROGRAM_ID> --url devnet`
9. Runs consistency guard

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
  - **Cause:** Forced config fallback identity is incomplete/invalid (`RECEIPT_IDENTITY_SOURCE=config`) or non-devnet fallback identity was requested but incomplete.
  - **Action:** Prefer manifest mode (unset `RECEIPT_IDENTITY_SOURCE`) or provide complete config fallback fields.

- `RECEIPT_IDL_MISMATCH`
  - **Cause:** Runtime `full-v1` hash of committed IDL artifact differs from configured hash.
  - **Action:** Re-run deploy script to refresh `receipt.idl.json` + manifest atomically.

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
