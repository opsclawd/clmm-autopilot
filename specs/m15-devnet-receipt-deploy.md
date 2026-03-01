# specs/m15-devnet-receipt-deploy.spec.md
# M15 — Deploy receipt program to devnet (real idempotency)

## Goal
Deploy the Anchor “receipt/claim” program to Solana **devnet** and wire the deployed program id + matching IDL into the app config so devnet execution is truly end-to-end with **on-chain idempotency** (0 receipts before, 1 receipt after).

## Non-goals
- Mainnet deployment.
- Upgrading receipt schema or changing PDA derivation rules.
- Adding admin controls, migrations, or multi-authority support.
- Changing execution flow beyond enabling receipt writing and prechecks.

## Scope

### In scope
1) Anchor config hard separation (devnet vs mainnet/localnet)
2) Build + deploy program to devnet
3) Wire `receiptProgramId` + `receiptIdl` into app config for devnet
4) Add a deterministic receipt sanity harness verifying:
   - precheck finds **0** receipts before execution
   - post-execution finds **1** receipt
5) Operator runbook updates for devnet deploy + verification

### Out of scope
- Receipt indexing or external database storage.
- Notifications.
- Governance/upgrade authority workflows beyond basic devnet deploy.

## Requirements

## A) Anchor config hard separation

### 1) Anchor.toml
- Must include a **devnet** cluster entry and be explicit about RPC URL.
- Must not rely on implicit defaults that can silently deploy to the wrong cluster.

**Required properties**
- `[provider]` or `[provider.devnet]` (depending on your structure) must point to a devnet RPC URL.
- Wallet/keypair path must be explicit and consistent with the operator workflow.

### 2) App config
Update `AutopilotConfig` (or equivalent) to support devnet receipt deployment:

Required config values for devnet:
- `cluster = "devnet"`
- `receiptProgramId = "<DEVNET_PROGRAM_ID>"`
- `receiptIdl` must match the deployed program’s IDL exactly.

**Invariants**
- If `cluster=devnet` and `receiptProgramId` is unset or invalid -> fail fast with canonical error (e.g., `RECEIPT_PROGRAM_NOT_CONFIGURED`).
- If IDL does not match program (or cannot be loaded) -> fail fast with canonical error (e.g., `RECEIPT_IDL_MISMATCH`).
- Client must never write receipts when configured for a cluster where the program is not deployed.

## B) Build + deploy

### 1) Build
- Command: `anchor build`
- Output artifacts expected:
  - program binary
  - IDL JSON file produced (location per your repo conventions)

### 2) Deploy to devnet
- Command: `anchor deploy --provider.cluster devnet` (or equivalent for your workflow)
- The deploy step must output a **program id**.

### 3) Persist program id
Record the returned program id and store it in all required locations:

- `programs/<name>/src/lib.rs`:
  - `declare_id!("<DEVNET_PROGRAM_ID>");` (if that is your pattern)
- App config registry for devnet:
  - e.g. `configs/devnet.json` or `packages/core/src/config/cluster/devnet.ts`

**Definition**
- The devnet program id must be a single source of truth for the app’s runtime configuration.
- No hardcoded “temporary” ids in random files.

## C) Sanity checks (must be automated)

### 1) On-chain program presence
- Required command:
  - `solana program show <DEVNET_PROGRAM_ID> --url devnet`
- This must succeed in CI/local harness and must be referenced in the operator runbook.

### 2) Receipt precheck/postcheck must prove idempotency
Add/extend a devnet harness (or integration test) that verifies:

1) Given:
   - `cluster=devnet`
   - `receiptProgramId` configured
   - a known position address eligible for trigger (or a controlled test position)
2) Before execution:
   - `receipt precheck` returns **0** matching receipts for the current epoch (per your receipt PDA scheme)
3) Execute once:
   - tx confirms successfully
4) After execution:
   - `receipt precheck` returns **1** receipt (and it matches the expected PDA)
5) Execute again in same epoch:
   - must fail deterministically (client-side precheck or on-chain constraint), with a canonical error (e.g., `RECEIPT_ALREADY_EXISTS`).

**Hard requirement**
- If you cannot produce this before/after receipt state on devnet, you do not have idempotency.

## D) Documentation / Runbook updates
Update operator documentation to include:

- Required env vars / keypair setup for devnet deploy
- Exact deploy commands
- Where the program id must be copied
- Program verification command (`solana program show ...`)
- Receipt verification steps (0 -> 1)
- Failure triage:
  - wrong cluster
  - wrong program id
  - outdated IDL
  - PDA derivation mismatch
  - insufficient SOL for deployment or transactions

## Tests

### Unit tests
- Config validation:
  - devnet config missing `receiptProgramId` => fail fast
  - devnet config with invalid pubkey => fail fast
  - IDL missing/unloadable => fail fast

### Integration / devnet harness
- Program presence check (shell step)
- Receipt 0 -> 1 verification (must run against devnet)
- Duplicate execution rejection in same epoch (must be deterministic)

## Deliverables
- Updated `Anchor.toml` with explicit devnet cluster config
- Deployed devnet receipt program id stored in:
  - `declare_id!()` (if used)
  - app devnet config registry
- App loads the devnet receipt IDL and uses it to build receipt instruction
- Devnet harness proving receipt 0 -> 1 and duplicate-block behavior
- Operator runbook updated

## Acceptance criteria (Definition of Done)
- `anchor build` succeeds.
- `anchor deploy --provider.cluster devnet` succeeds and program id is persisted in repo config.
- `solana program show <DEVNET_PROGRAM_ID> --url devnet` succeeds.
- Devnet harness shows:
  - 0 receipts before execution
  - 1 receipt after execution
  - second attempt in same epoch blocked deterministically
- All tests pass (`pnpm test` / repo equivalent), and the devnet runbook steps are accurate and reproducible.