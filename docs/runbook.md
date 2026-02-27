# Operator Runbook (M12)

## Commands

```bash
pnpm install
pnpm -r test
pnpm e2e:devnet
```

Harness env vars:

- `RPC_URL` (required)
- `AUTHORITY_KEYPAIR` (required, dev-only local keypair JSON path)
- `POSITION_ADDRESS` (required, devnet position account)

Example:

```bash
set -a
source .env
set +a
pnpm e2e:devnet
```

## What `pnpm e2e:devnet` does

1. Fetches position snapshot from devnet
2. Enforces SOL/USDC guardrail (`NOT_SOL_USDC` on mismatch)
3. Evaluates policy decision from canonical tick samples
4. If HOLD: exits `0`
5. If TRIGGER: checks receipt PDA for canonical epoch (`ALREADY_EXECUTED_THIS_EPOCH` if found)
6. Fetches Jupiter quote, computes canonical M9 attestation payload/hash
7. Builds tx + simulates (simulation gate)
8. Sends + confirms
9. Fetches receipt and verifies:
   - authority
   - position_mint
   - epoch
   - direction
   - stored hash equals local attestation hash

Logs are JSON (structured) and failure exits non-zero.

## Current Deferred Flags (Intentional)

The following runtime flags remain enabled for this milestone and are intentional:

- `JUPITER_SWAP_DISABLED_FOR_TESTING=true` in `packages/solana/src/jupiter.ts`
- `DISABLE_RECEIPT_PROGRAM_FOR_TESTING=true` in `packages/solana/src/receipt.ts`

Expected impact while flags are ON:

- Quote/swap calls are synthesized or omitted for deterministic testability.
- Receipt instruction is not appended in live tx builder path.
- M5/M12 behavior is partially deferred until those flags are disabled in later milestones.

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
