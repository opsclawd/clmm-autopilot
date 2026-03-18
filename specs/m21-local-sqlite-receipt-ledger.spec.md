# M21 — Local SQLite receipt ledger + on-chain toggle

## Summary
Make the local SQLite database the authoritative runtime receipt ledger for duplicate-execution protection and auditability, while adding an explicit operator toggle to enable or disable the on-chain receipt write.

This milestone keeps the canonical receipt identity and attestation model from M2/M5/M9, but decouples live execution from the requirement that every successful exit must write an Anchor receipt account. The SQLite ledger becomes the primary receipt system for the running autopilot. The on-chain receipt becomes an optional supplemental proof path.

## Problem
The current execute path treats the on-chain receipt program as the only durable receipt authority. That creates three practical constraints:

- live execution remains coupled to receipt manifest/IDL/program verification even when the operator only needs local idempotency
- every successful exit pays for the receipt instruction even when an off-chain ledger is sufficient
- there is no explicit supported way to keep local receipt tracking while turning on-chain receipt writes off

At the same time, the repo already has deterministic SQLite persistence for mainnet shadow artifacts. M21 should reuse that local durability pattern for live receipt state instead of forcing the receipt program to be the only duplicate-execution gate.

## Hard constraint
SQLite is not distributed consensus.

If on-chain receipts are disabled, duplicate protection is only authoritative for writers that share the same SQLite database file. M21 therefore supports:

- single-writer operation on one host, or
- multiple local processes that share one SQLite database path on shared storage

M21 does **not** provide cross-host duplicate protection for independent databases. That remains out of scope unless on-chain receipts stay enabled or a separate distributed lock/consensus system is introduced later.

## Goals
- Make SQLite the primary receipt ledger for runtime idempotency.
- Preserve the canonical receipt identity tuple:
  - `(cluster, authority, position_mint, epoch)`
- Preserve the canonical epoch definition and attestation hash model already used by the on-chain receipt path.
- Add an explicit config toggle for on-chain receipt writes.
- Allow live execution to run without receipt manifest/IDL config when on-chain receipts are disabled.
- Keep the existing live/shadow decisioning and tx-building paths unified except for the receipt backend behavior.
- Reuse the current SQLite runtime patterns and remain compatible with the existing shadow artifact database layout.

## Non-goals
- Removing the Anchor receipt program from the repo.
- Changing the canonical attestation payload format.
- Solving active-active multi-host duplicate prevention without shared storage.
- Replacing the existing shadow artifact tables or schema.
- Backfilling the entire historical on-chain receipt corpus into SQLite.

## Scope

### In scope
- config support for local receipt storage and explicit on-chain receipt toggle
- SQLite-backed receipt claim/confirm/fail lifecycle
- execute-path precheck and post-confirmation wiring against the local ledger
- optional continued appending/verifying of the on-chain receipt instruction
- migration/import path for safe transition from on-chain-only to local-ledger mode
- operator logs/runbook updates
- tests covering duplicate blocking, toggle behavior, recovery, and config safety

### Out of scope
- governance/release changes to the Anchor receipt program itself
- replacing SQLite with Postgres or another external database
- UI redesign beyond minimal surfacing of receipt backend state
- distributed leader election or cluster-wide locking

## Requirements

## A) Receipt backend model
Introduce a formal runtime receipt backend model in config.

### Required config
- `execution.localReceiptDbPath: string`
  - path to the SQLite database that stores authoritative local execution receipts
  - may point to the existing shadow DB file or a dedicated receipt DB file
- `execution.onChainReceiptEnabled: boolean`
  - controls whether the receipt instruction is appended and verified on-chain
- `execution.localReceiptClaimTtlMs: number`
  - stale-claim timeout used for recovery of abandoned in-flight local claims

### Default behavior
- `devnet-live`: `onChainReceiptEnabled=true`
  - preserves current devnet proof/e2e behavior by default
- `mainnet-shadow`: `onChainReceiptEnabled=false`
  - shadow mode never writes receipts on-chain
- `mainnet-live`: `onChainReceiptEnabled=false`
  - local SQLite is primary by default; on-chain receipt is opt-in

### Validation rules
- any execute-capable runtime must have a resolvable `execution.localReceiptDbPath`
- `mainnet-shadow + execution.onChainReceiptEnabled=true` is invalid
- `execution.onChainReceiptEnabled=true` requires the current receipt identity/manifest validation rules
- `execution.onChainReceiptEnabled=false` must not require receipt manifest/IDL/program config at startup

## B) Canonical local receipt identity
The local ledger must preserve the same duplicate-execution key as the on-chain receipt program.

### Canonical uniqueness key
- `cluster`
- `authority`
- `position_mint`
- `epoch`

`epoch` must continue using the canonical UTC-day definition from M2/SPEC:
- `unixDays = floor(unixTs / 86400)`

### Required stored fields
At minimum, each confirmed local receipt row must store:
- `cluster`
- `execution_mode`
- `authority`
- `position_address`
- `position_mint`
- `whirlpool_address`
- `epoch`
- `direction`
- `attestation_hash`
- `attestation_payload_hash or payload bytes`
- `status`
- `claimed_at`
- `confirmed_at`
- `tx_signature` (nullable until confirmation)
- `confirmed_slot` (nullable until confirmation)
- `on_chain_receipt_enabled`
- `on_chain_receipt_pda` (nullable)
- `on_chain_receipt_verified`
- last error metadata for failed attempts

### Schema requirements
- SQLite schema creation/migration must be idempotent
- WAL mode should remain enabled for concurrent local readers/writers
- the receipt tables must coexist cleanly with existing `shadow_*` tables if the same DB file is used
- the uniqueness invariant must be enforced by SQLite, not by in-memory checks alone

## C) Local receipt lifecycle
The SQLite ledger is the primary runtime receipt authority for execute mode.

### Receipt states
At minimum, the lifecycle must support:
- `pending`
- `confirmed`
- `failed`

### Claim semantics
Before a live send is attempted, the runtime must acquire a local receipt claim for the canonical key inside a SQLite transaction.

### Required behavior
1. If a `confirmed` local receipt already exists for the canonical key, execution must fail with `ALREADY_EXECUTED_THIS_EPOCH`.
2. If a fresh `pending` local receipt already exists for the canonical key, execution must fail closed and not send.
3. If a `pending` claim is stale beyond `execution.localReceiptClaimTtlMs`, the runtime may recover it deterministically.
4. Build/simulation failures before send must not leave an unrecoverable permanent duplicate block.
5. Send failures or post-send confirmation failures must update the local receipt row with failure metadata so operators can diagnose and safely retry.
6. Successful confirmation must mark the local receipt row `confirmed`.

### Recovery requirement
The implementation must define one deterministic recovery path for abandoned `pending` rows. The exact mechanism may be:
- claim takeover after TTL expiry, or
- explicit operator repair command

But the behavior must be documented and tested.

## D) Execute pipeline behavior
The live execute path must continue using the same decision/build/sim/send flow, with receipt behavior switched by config instead of by a separate execution implementation.

### When `execution.onChainReceiptEnabled=false`
- local SQLite receipt precheck is authoritative
- receipt identity resolution is skipped
- receipt instruction is not appended to the transaction
- on-chain receipt polling/verification is skipped
- successful execution still produces a confirmed local receipt record

### When `execution.onChainReceiptEnabled=true`
- local SQLite receipt precheck remains authoritative for runtime dedupe
- the existing receipt identity resolution still runs
- the receipt instruction is appended exactly as today
- on-chain receipt verification still runs after confirmation
- successful execution produces:
  - a confirmed local receipt row
  - an on-chain receipt verification result tied to the same canonical key

### Simulation-only behavior
- `simulate-only` may read the local receipt table for duplicate precheck
- `simulate-only` must not create durable `pending` claims

## E) Eventing, metadata, and operator visibility
Receipt backend behavior must be visible in runtime outputs.

### Required metadata changes
Execution metadata/artifacts must distinguish:
- local receipt planned
- local receipt confirmed
- on-chain receipt enabled
- on-chain receipt instruction included
- on-chain receipt verified

Existing generic receipt fields such as `receiptWritePlanned` or `receiptIxIncluded` must be updated or expanded so they are not ambiguous once local and on-chain receipt paths can diverge.

### Required operator visibility
- startup logs must print:
  - local receipt DB path
  - whether on-chain receipt is enabled
- when on-chain receipt is disabled, logs/runbook must clearly state that duplicate protection is limited to the shared SQLite scope

## G) Tooling and runbook
Operators need a small local-ledger inspection path comparable to the current receipt consistency tools.

### Required operator tooling
At minimum, provide one read-oriented interface that can inspect local receipts by:
- DB path
- authority
- position mint or position address
- epoch
- status

This may be a CLI, script, or lightweight internal command, but it must not require direct ad hoc SQL editing by operators.

### Runbook updates
Documentation must cover:
- how to configure the local receipt DB
- when to enable or disable on-chain receipts
- the single-writer/shared-DB safety assumption
- how to inspect local receipts
- how to recover stale `pending` claims
- how to safely transition from on-chain-enabled to on-chain-disabled mode

## Test plan

### Config tests
- rejects execute mode when `execution.localReceiptDbPath` is missing
- rejects `mainnet-shadow + execution.onChainReceiptEnabled=true`
- does not require receipt identity config when `execution.onChainReceiptEnabled=false`
- still requires receipt identity config when `execution.onChainReceiptEnabled=true`

### SQLite receipt store tests
- creates schema idempotently
- enforces uniqueness for `(cluster, authority, position_mint, epoch)`
- blocks duplicate claim when row is `confirmed`
- blocks duplicate claim when row is fresh `pending`
- allows deterministic recovery of stale `pending` claim
- marks success/failure transitions correctly

### Execute-path tests
- local-receipt-only mode blocks same-epoch duplicate execution without any on-chain receipt config
- local-receipt-only mode omits receipt ix from the built transaction
- on-chain-enabled mode still appends receipt ix and verifies it after confirmation
- local receipt row is confirmed only after successful send/confirmation
- build/send failure leaves a diagnosable local record and a retryable path
- `simulate-only` reads duplicate state but does not create durable claims

### Integration / harness tests
- devnet scenario with `onChainReceiptEnabled=true` preserves current receipt-proof behavior
- devnet scenario with `onChainReceiptEnabled=false` proves same-epoch duplicate block using SQLite only
- if the shadow DB file is reused, shadow tables and receipt tables coexist without schema conflicts

## Deliverables
- config updates for `execution.localReceiptDbPath`, `execution.onChainReceiptEnabled`, and stale-claim TTL
- SQLite receipt store module with schema/migration logic
- execute-path integration against the local receipt lifecycle
- optional on-chain receipt append/verify toggle wired through the builder/runtime
- local receipt inspection/import tooling
- runbook updates
- tests covering config, lifecycle, recovery, and toggle behavior

## Acceptance criteria (Definition of Done)
M21 is complete only if all of the following are true:

1. Live execution can use a local SQLite ledger as the authoritative duplicate-execution gate.
2. The canonical uniqueness key remains `(cluster, authority, position_mint, epoch)`.
3. Operators can explicitly turn on-chain receipt writes on or off via config.
4. When on-chain receipts are off, live execution no longer requires receipt manifest/IDL/program config.
5. When on-chain receipts are on, the existing on-chain receipt path still works and is tied to the same local receipt record.
6. Duplicate execution in the same epoch is blocked deterministically through the local ledger.
7. The recovery path for abandoned `pending` claims is documented and tested.
8. Operators can inspect local receipt state without manual SQL editing.
9. Runbooks clearly document the single-writer/shared-DB safety boundary when on-chain receipts are disabled.

## Suggested files
- `packages/core/src/config.ts`
- `packages/solana/src/executeOnce.ts`
- `packages/solana/src/runtime.ts`
- `packages/solana/src/shadow/artifactStore.ts` or a new sibling receipt-store module
- `packages/solana/src/__tests__/executeOnce.spec.ts`
- `packages/solana/src/__tests__/config.spec.ts`
- `packages/solana/src/__tests__/receipt.spec.ts`
- `docs/runbook.md`
