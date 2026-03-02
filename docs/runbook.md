# Operator Runbook (M15)

## Commands

```bash
pnpm install
pnpm -r test
pnpm receipt:check:devnet
pnpm e2e:devnet
```

Deploy/update devnet receipt program identity (manual acceptance workflow):

```bash
pnpm receipt:deploy:devnet
```

Harness env vars:

- `RPC_URL` (required)
- `AUTHORITY_KEYPAIR` (required, dev-only local keypair JSON path)
- `POSITION_ADDRESS` (required, devnet position account)
- `SWAP_ROUTER` (optional: `noop` | `orca` | `jupiter`, default `noop` for deterministic harness runs)
- `FORCE_DECISION` (optional: `TRIGGER_DOWN` | `TRIGGER_UP`; overrides live policy decision to force receipt proof path)
- `REQUIRE_RECEIPT_PROOF` (optional: `1|0|true|false`, default `0`; when enabled, `HOLD` is treated as failure)

Example:

```bash
set -a
source .env
set +a
pnpm receipt:check:devnet
pnpm e2e:devnet
```

## What `pnpm e2e:devnet` does

0. Resolves receipt identity from `deployments/devnet/receipt.json` (manifest precedence over duplicated config fields)
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

## Consistency guard

`pnpm receipt:check:devnet` is mandatory before harness/manual workflow. It asserts:

1. Runtime resolver identity equals manifest identity (`programId`, `idlHashMode`, `idlHash`, `idlPath`)
2. `idlPath` exists on disk

If this fails, do not run harness until manifest/IDL drift is fixed.

## Deploy flow details

`pnpm receipt:deploy:devnet` runs:

1. `anchor build`
2. `anchor deploy --provider.cluster devnet`
3. Copies `target/idl/receipt.json` to `deployments/devnet/receipt.idl.json`
4. Computes `subset-v1` IDL hash
5. Atomically writes `deployments/devnet/receipt.json`
6. Verifies with `solana program show <PROGRAM_ID> --url devnet`
7. Runs consistency guard

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
  - **Cause:** Resolver could not build complete receipt identity (manifest missing/invalid or fallback incomplete).
  - **Action:** Run `pnpm receipt:check:devnet`, then fix manifest fields or deploy flow.

- `RECEIPT_IDL_MISMATCH`
  - **Cause:** Runtime `subset-v1` hash of committed IDL artifact differs from configured hash.
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
