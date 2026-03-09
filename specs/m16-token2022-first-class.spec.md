# M16 — Token-2022 first-class support (ATAs + Whirlpool v2 + test matrix)

## Goal
Make Token-2022 handling a first-class, deterministic capability across the codebase so devnet/mainnet execution works for pools and mints using SPL Token Extensions. This includes correct token-program resolution per mint, correct ATA creation/lookup, correct Orca Whirlpool instruction variants (v2) when Token-2022 is involved, and a minimum compatibility test matrix.

## Non-goals
- Supporting every Token-2022 extension feature (transfer hooks, confidential transfers, etc.) beyond what Orca Whirlpool requires.
- Implementing a generic token-framework or “any token on Solana” abstraction.
- Refactoring all token utilities unrelated to execution/swap/receipt paths.

## Scope

### In scope
1) Universal token program resolution for each mint (Token vs Token-2022).
2) ATA creation/lookup updated to use correct token program id per mint.
3) Orca Whirlpool instruction variant selection:
   - Use a single canonical path that is valid for all token-program combinations (recommended: Whirlpool v2 everywhere).
   - If dual-path is retained (v1 + v2), document why and add explicit tests for both branches.
4) Memo program handling when required by Whirlpool v2 paths.
5) Minimum test matrix across all token-program combinations.

### Out of scope
- Adding new supported pairs beyond current MVP guardrails.
- Handling non-ATA token accounts (custom token accounts) beyond reading balances if needed.
- Building a new swap router; this milestone targets correctness of token plumbing.

## Requirements

## A) Token program resolution (authoritative, reusable)
Add a single authoritative resolver in `packages/solana` (or `packages/core` if you already keep chain constants there):

### API
`resolveTokenProgramForMint(connection, mintPubkey) -> TokenProgramInfo`

`TokenProgramInfo` must include:
- `tokenProgramId` (either SPL Token program id or SPL Token-2022 program id)
- `isToken2022: boolean`
- `mintPubkey`

### Rules
- Resolver must be based on on-chain mint account owner:
  - owner == `TOKEN_PROGRAM_ID` -> Token (spl-token)
  - owner == `TOKEN_2022_PROGRAM_ID` -> Token-2022
- If mint owner is neither, return a canonical error (e.g., `UNSUPPORTED_MINT_OWNER`).
- Cache results in-memory per process run to avoid repeated RPC calls (must be safe and bounded).

### Deliverable locations
- `packages/solana/src/token/program.ts` (or equivalent)
- Central constants for:
  - `TOKEN_PROGRAM_ID`
  - `TOKEN_2022_PROGRAM_ID`
  - `ASSOCIATED_TOKEN_PROGRAM_ID`
  - `MEMO_PROGRAM_ID` (if needed by Whirlpool v2 paths)

## B) ATA create/resolve must be token-program aware
Everywhere the builder or adapters create/resolve token accounts:

### Requirements
- Derive ATA address using the correct token program id for the mint.
- Create ATA instructions must specify:
  - associated token program id
  - token program id (Token vs Token-2022)
  - mint, owner, payer
- Never assume USDC is always Token (spl-token). Always resolve based on mint owner.

### Deliverables
- A single function:
  - `getOrCreateAtaIxs({ payer, owner, mint, tokenProgramId }) -> { ata, ixs[] }`
- Refactor all callsites in:
  - execution builder (exit tx)
  - swap adapters (Jupiter/orca/noop as applicable)
  - any SOL/WSOL lifecycle code (if WSOL ATA creation exists)

### Invariants
- No code path may use a hardcoded token program id when the mint program can differ.
- Any ATA creation must be conditional (only if missing), consistent with current builder patterns.

## C) Orca Whirlpool instruction variants (v2 when Token-2022 involved)
Update Orca Whirlpool instruction construction to select the correct variant:

### Variant selection rule (canonical)
- Default requirement: use Whirlpool v2 instruction paths and supply required extra accounts for all supported pools:
  - token program ids for both sides
  - mint accounts for both sides
  - memo program id where required
- Optional dual-path mode (only if intentionally kept):
  - v1 may be used for token/token pools
  - v2 must be used whenever either side is Token-2022
  - include explicit tests proving correct branch selection

### Required behavior
- All Whirlpool-related instructions in the live execution path must be Token-2022 compatible:
  - remove liquidity
  - collect fees/rewards
  - swaps (if OrcaWhirlpoolSwapAdapter is used)
- Instruction builders must accept a `TokenContext` object that includes:
  - `tokenProgramA`, `tokenProgramB`
  - `mintA`, `mintB`
  - `isToken2022A`, `isToken2022B`

### Deliverables
- Centralized Whirlpool ix builder module updated to:
  - resolve token programs for mintA/mintB once per build
  - pick v1/v2 instruction variant
  - include memo program account where required
- Remove any brittle “works on token-only” assumptions.

## D) Tests: minimum compatibility matrix
Add unit/integration tests covering these token-program combinations:

1) token/token (both spl-token)
2) token2022/token
3) token/token2022
4) token2022/token2022

### Test requirements
- Tests must validate:
  - resolver returns correct token program ids from mocked mint owners
  - ATA derivation uses correct token program id
  - requirements computation for swap quote input/output ATAs uses the resolved token program per mint (no implicit `TOKEN_PROGRAM_ID` default)
  - Whirlpool ix builder chooses v1 vs v2 correctly
  - v2 instruction builders include required extra accounts (token programs, mint accounts, memo when required)

### Implementation guidance
- Unit tests: mock mint account owner to simulate token/token2022 without requiring chain state.
- Integration-ish tests: build a transaction message and assert:
  - accounts list includes expected program ids and mints
  - instruction data discriminators correspond to v1 vs v2 builders (as applicable)
- If you have a devnet harness:
  - add at least one devnet scenario exercising a Token-2022 pool (if available and stable), but do not block CI on devnet flakiness unless you already accept that.

## Deliverables
- Token program resolver + cache
- Token-program-aware ATA utilities
- Whirlpool instruction builders updated for v2 when Token-2022 involved (including memo handling)
- Updated execution builder and swap adapters to use resolver + ATA utilities
- Test suite implementing the 4-case matrix

## Acceptance criteria (Definition of Done)
- No hardcoded assumptions that USDC (or any mint) uses spl-token; token program is always resolved from chain/mocks.
- `computeExecutionRequirements` (or equivalent requirements module) derives quote input/output ATAs with the correct token program per mint; no default-to-`TOKEN_PROGRAM_ID` for unknown quote mints.
- Builder can construct valid instruction sets for any of the 4 matrix cases without missing required accounts.
- Unit tests cover resolver + ATA derivation + v1/v2 selection and pass reliably.
- Execution path is Token-2022 compatible for remove/collect/swap, with memo program included when required by v2 instructions.
