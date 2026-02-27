# M14 — Swap adapters (explicit backends, cluster-gated)

## Goal
Decouple swap execution from a single hardwired router by introducing a strict `SwapAdapter` interface in `packages/core` and implementing explicit backends in `packages/solana` (Jupiter mainnet, Orca Whirlpool single-pool devnet+mainnet, and Noop), with config-driven selection and deterministic devnet E2E behavior.

## Non-goals
- Multi-hop routing inside Orca swaps (single Whirlpool swap only).
- Auto-selection of best route across routers.
- New notification infrastructure.
- Adding new token pairs beyond current MVP constraints (e.g., SOL/USDC enforcement remains as-is).

## Scope

### In scope
1) `SwapAdapter` interface (core) with strict typing and contract tests.
2) Concrete adapters (solana):
   - `JupiterSwapApiAdapter` (mainnet only; HTTP quote + swap-instructions)
   - `OrcaWhirlpoolSwapAdapter` (devnet + mainnet; single-pool swap)
   - `NoopSwapAdapter` (all clusters; returns no swap instructions)
3) Config updates:
   - Add `swapRouter: "jupiter" | "orca" | "noop"`
   - Define per-cluster defaults (devnet: `orca` (or `noop`), mainnet: `jupiter`)
4) Integrate adapter selection into execution builder without branching sprawl.
5) Tests:
   - Unit tests for adapter selection and gating
   - Integration-ish tests (mocked) for tx building behavior with each adapter
   - Devnet harness update to use `orca` or `noop` for deterministic testing

### Out of scope
- Swaps across multiple pools, best-price routing, or pathfinding beyond a single Whirlpool.
- Rewriting the policy engine logic beyond adding config plumbing.
- Changing receipt schema beyond adding swap router identifiers already defined in earlier milestones (if present).

## Requirements

### A) Core: strict `SwapAdapter` interface
Add in `packages/core`:

#### Types
- `Cluster` enum/type must already exist; if not, introduce canonical `Cluster = "devnet" | "mainnet"` (or reuse existing).
- `SwapRouter` union: `"jupiter" | "orca" | "noop"`
- `SwapQuote` (router-agnostic) minimal shape required by builder:
  - `router: SwapRouter`
  - `inMint: PublicKeyString`
  - `outMint: PublicKeyString`
  - `inAmount: bigint` (minor units)
  - `minOutAmount: bigint` (minor units)
  - `slippageBps: number`
  - `quotedAtMs: number`
  - `debug?: Record<string, unknown>` (optional; never used for logic)

#### Interface
`packages/core/src/swap/SwapAdapter.ts` (or equivalent module):
- `name: SwapRouter`
- `supportsCluster(cluster: Cluster): boolean`
- `getQuote(params: GetQuoteParams): Promise<SwapQuote>`
- `buildSwapIxs(quote: SwapQuote, payer: PublicKey): Promise<TransactionInstruction[]>`

`GetQuoteParams` must include:
- `cluster`
- `connection` (or keep connection in solana package; decide one approach and keep it consistent)
- `inMint`, `outMint`
- `inAmount`
- `slippageBpsCap`
- `deadlineMs` (optional)
- `quoteFreshnessMs` (optional) for later reliability logic

**Contract rules**
- `getQuote` must return router-agnostic `SwapQuote` with `router` set correctly.
- `buildSwapIxs` must throw a typed error if quote.router != adapter.name.
- `buildSwapIxs` must be deterministic for identical inputs (given same chain state and deterministic accounts).

### B) Solana: adapter implementations

#### 1) `JupiterSwapApiAdapter` (mainnet only)
Location: `packages/solana/src/swap/jupiter/JupiterSwapApiAdapter.ts`

Rules:
- `supportsCluster("mainnet") = true`
- `supportsCluster("devnet") = false` (must hard-fail early with canonical error)
- Uses:
  - `https://api.jup.ag/swap/v1/quote`
  - `https://api.jup.ag/swap/v1/swap-instructions` (or equivalent instruction endpoint used by the codebase)
- Must enforce:
  - slippage cap (`slippageBpsCap`) in quote request
  - quote freshness constraints already used in the execution builder (no new policy changes)
- Must return `TransactionInstruction[]` from the swap-instructions response.

Notes:
- If existing Jupiter code exists, refactor to implement the adapter interface rather than duplicating logic.
- No devnet fallbacks inside Jupiter adapter.

#### 2) `OrcaWhirlpoolSwapAdapter` (devnet + mainnet)
Location: `packages/solana/src/swap/orca/OrcaWhirlpoolSwapAdapter.ts`

Rules:
- `supportsCluster("devnet") = true`
- `supportsCluster("mainnet") = true`
- Only supports *single-pool* Whirlpool swap for the exact pair used in MVP guardrails (expected SOL/USDC mints).
- Quote strategy:
  - Use on-chain Whirlpool state to compute a conservative minOut given `slippageBpsCap`
  - If the SDK provides quote helpers, use them; otherwise implement minimal quote math with clear tests.
- Instruction building:
  - Build the Whirlpool swap instruction(s) required for swapping the exposure amount.
  - Must handle token program selection correctly (Token vs Token-2022) based on mints/accounts, consistent with the rest of the builder.

Constraints:
- No route discovery. It must be given the target Whirlpool (from snapshot) or deterministically derive it from snapshot (preferred).
- If the position snapshot does not provide the needed Whirlpool reference, extend snapshot to carry it (without breaking existing APIs).

#### 3) `NoopSwapAdapter` (all clusters)
Location: `packages/solana/src/swap/noop/NoopSwapAdapter.ts`

Rules:
- `supportsCluster(cluster) = true`
- `getQuote` returns a `SwapQuote` with `minOutAmount = 0n`, `inAmount` set, `router="noop"`, and timestamps.
- `buildSwapIxs` returns `[]`
- Must never make network calls.

Use cases:
- Deterministic devnet testing focused on remove+collect+receipt.
- Explicit mode when swap is disabled by config (never silent).

### C) Config updates (core)
Update `AutopilotConfig` in `packages/core`:

- Add `execution.swapRouter: "jupiter" | "orca" | "noop"`

Defaults:
- `devnet` default: `"orca"` (allowed override to `"noop"`)
- `mainnet` default: `"jupiter"`

Rules:
- If `swapRouter` is set to an adapter that does not support the selected cluster, fail fast with a canonical error code (e.g., `SWAP_ROUTER_UNSUPPORTED_CLUSTER`).

### D) Execution builder integration (solana)
Update `buildExitTransaction(...)` pipeline:

- Replace hardwired swap logic with:
  1) determine whether swap is needed (existing dust rules / swap-skip thresholds)
  2) if swap is needed:
     - select adapter by config (`swapRouter`)
     - assert `supportsCluster(cluster)` else error
     - `quote = await adapter.getQuote(params)`
     - `swapIxs = await adapter.buildSwapIxs(quote, payer)`
     - append swapIxs at the canonical step in the tx
  3) if swap is omitted:
     - do not call adapter (or use noop adapter explicitly—choose one canonical approach)
- Receipt/attestation integration:
  - If attestation payload includes `router`/`swapPlanned`/`swapSkipped`, populate it consistently:
    - `swapPlanned=false` when omitted due to dust or config noop
    - If you track “planned but skipped,” keep semantics consistent across adapters

No branching sprawl:
- Builder should not contain router-specific logic.
- Router-specific account/instruction complexity belongs inside adapters.

## Testing

### Unit tests (core)
- `SwapAdapter` contract tests using a lightweight fake adapter:
  - mismatch router -> throws
  - supportsCluster gating required

### Unit tests (solana)
- Adapter selection:
  - devnet + jupiter => fails with `SWAP_ROUTER_UNSUPPORTED_CLUSTER`
  - mainnet + jupiter => ok
  - any cluster + noop => ok
- Noop:
  - returns empty ixs
  - never calls network (mock fetch not invoked)

### Builder tests
- With `swapRouter=noop` and swap-needed=false => tx contains no swap ixs, still contains remove+collect (+ receipt if enabled)
- With `swapRouter=noop` and swap-needed=true => tx contains no swap ixs, and attestation/receipt reflects swap omitted mode (per canonical semantics)
- With `swapRouter=orca` and swap-needed=true => tx includes Whirlpool swap ix(s) in correct order
- With `swapRouter=jupiter` on mainnet config => builder uses adapter and appends ixs (mock HTTP)

### Devnet E2E harness update
- Default devnet harness uses `orca` or `noop` per config.
- Harness must be able to run without external HTTP swap dependency.
- Update operator runbook steps accordingly.

## Deliverables
- `packages/core`:
  - `SwapAdapter` interface + types
  - `AutopilotConfig` updated with `execution.swapRouter`
  - canonical error code for unsupported cluster
- `packages/solana`:
  - `JupiterSwapApiAdapter`
  - `OrcaWhirlpoolSwapAdapter`
  - `NoopSwapAdapter`
  - adapter registry/selector function (single place)
  - execution builder refactor to use adapters
- Tests:
  - core contract tests
  - solana adapter tests
  - builder integration tests
- Docs:
  - short section in `SPEC.md` or `architecture.md` describing swap routers, cluster gating, and devnet defaults

## Acceptance criteria (Definition of Done)
- All unit tests pass (`pnpm test` or repo equivalent).
- Builder no longer directly calls Jupiter/Orca swap logic; it only calls the adapter interface.
- Config supports `swapRouter` and enforces cluster gating with a canonical error.
- Devnet E2E can run with `swapRouter=orca` or `swapRouter=noop` without failing due to missing Jupiter devnet endpoints.
- Mainnet build path remains intact with `swapRouter=jupiter` (mocked test coverage required).