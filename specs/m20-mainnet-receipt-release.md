# M20 — Mainnet Receipt Release Engineering

## Summary
Establish a safe, repeatable, production-grade release path for the `receipt` Anchor program on Solana mainnet.  
This milestone does **not** change shadow-mode runtime semantics. It hardens how the receipt program is built, configured, deployed, verified, and documented so mainnet receipt identity is produced through an explicit release workflow instead of ad hoc manual mutation.

## Problem
The repository may contain a minimal receipt program that is deployable in principle, but the current deployment workflow is not mainnet-ready. Mainnet release risk currently comes from:
- devnet-only deployment workflow
- no explicit mainnet Anchor configuration
- source-mutating deploy mechanics
- no mainnet consistency verification
- no explicit upgrade-authority handling
- no documented release/runbook for mainnet receipt deployment

As a result, the system lacks a trustworthy path to produce the mainnet receipt program identity and artifacts that M19 mainnet shadow expects.

## Goals
- Add an explicit mainnet release workflow for the receipt program.
- Eliminate destructive source-file mutation from deployment.
- Produce canonical mainnet deployment artifacts and verification outputs.
- Make upgrade authority and release ownership explicit.
- Make mainnet receipt deployment auditable and reproducible.
- Enable operators to provision the mainnet receipt prerequisite for shadow mode and future live execution.

## Non-Goals
- Changing receipt program business logic.
- Expanding receipt accounts or instructions.
- Changing shadow-mode behavior.
- Enabling mainnet live execution of the broader autopilot.
- Building governance automation beyond the minimum needed to document and enforce upgrade authority expectations.

## Scope

### In Scope
- `Anchor.toml` mainnet configuration for the receipt program
- dedicated mainnet deploy script
- dedicated mainnet consistency/verification script
- non-destructive program-id handling
- canonical artifact generation under `deployments/mainnet/`
- release checklist and operator runbook
- upgrade authority declaration and checks
- CI and local validation for manifest/IDL/program-id consistency

### Out of Scope
- shadow runner changes already assigned to M19
- Jupiter / Whirlpool execution flow changes
- frontend UX changes
- DAO/governance system implementation
- multi-program release orchestration beyond `receipt`

## Deliverables

### 1. Mainnet Anchor Configuration
Add explicit mainnet support in repo configuration.

#### Requirements
- `Anchor.toml` includes a mainnet provider path or documented provider usage.
- `Anchor.toml` includes `[programs.mainnet]` for `receipt`.
- config supports build/deploy/verify flows without editing tracked source files in-place.

#### Acceptance Criteria
- repo can resolve a mainnet receipt program id through configuration alone
- mainnet build/deploy commands are documented and reproducible
- no release step requires hand-editing committed files during deployment

### 2. Non-Destructive Program ID Strategy
Replace source-mutating deploy mechanics with a release-safe approach.

#### Requirements
- program id management is explicit and deterministic
- deployment does not rely on unsafe in-place rewrites as the core workflow
- release process defines how the mainnet program id is introduced, reviewed, and preserved

#### Acceptance Criteria
- mainnet release workflow does not mutate tracked source files as a hidden side effect
- program id provenance is documented
- dry-run/review path exists before actual deployment

### 3. Mainnet Deploy Script
Create a dedicated mainnet deployment entrypoint.

#### Proposed file
- `scripts/deploy-receipt-mainnet.mjs`

#### Requirements
- validates required inputs before deploy
- builds the Anchor program for mainnet release
- deploys to mainnet with explicit RPC/provider selection
- emits canonical deployment outputs
- fails hard on missing config or inconsistent artifacts

#### Required Inputs
- mainnet RPC URL
- deployer keypair path or equivalent signer configuration
- target mainnet program keypair / program id source
- optional upgrade authority confirmation input
- artifact output directory

#### Outputs
- deployed program id
- deployed slot / signature metadata
- copied mainnet IDL artifact
- generated mainnet manifest JSON
- release summary suitable for operator logs

#### Acceptance Criteria
- one documented command can perform a mainnet receipt deployment
- failed preconditions abort before deployment
- success path emits the canonical files expected by downstream runtime consumers

### 4. Mainnet Deployment Artifacts
Define `deployments/mainnet/` as the source of truth for receipt runtime assets.

#### Required Files
- `deployments/mainnet/receipt.idl.json`
- `deployments/mainnet/receipt.json` (manifest)
- optional release metadata file if useful for auditability

#### Manifest Minimum Fields
- `programId`
- `cluster`
- `idlPath`
- `idlSha256` or equivalent deterministic hash
- `deployedSlot` or deployment metadata reference
- `updatedAt`
- `upgradeAuthority` status or declared authority reference

#### Acceptance Criteria
- runtime-facing artifact set is complete after deployment
- manifest points to the exact IDL that corresponds to the deployed program release
- downstream consumers can load mainnet receipt identity from manifest without manual repair

### 5. Mainnet Consistency Verification Script
Create a post-deploy verification tool.

#### Proposed file
- `scripts/check-mainnet-receipt-consistency.mjs`

#### Requirements
- verifies manifest program id matches intended mainnet deployment
- verifies IDL file exists and hash matches manifest
- verifies on-chain program account exists on mainnet
- verifies cluster metadata is mainnet, not devnet/localnet
- surfaces actionable failures

#### Acceptance Criteria
- script exits non-zero on any mismatch
- script can be run independently after deployment
- verification output is concise and operator-usable

### 6. Upgrade Authority / Governance Baseline
Make upgrade authority an explicit release concern.

#### Requirements
- document current upgrade authority model
- define who holds authority at initial mainnet deployment
- define whether authority remains hot, moves to multisig, or is intentionally frozen later
- add checks so release workflow prints and confirms current authority expectations

#### Acceptance Criteria
- upgrade authority is not implicit or tribal knowledge
- release runbook states exactly who controls upgrades at launch
- verification output includes authority state or explicit limitation if unavailable programmatically

## Public Interfaces / Behavior
This milestone adds release-engineering surfaces, not product behavior changes.

### New/Updated Interfaces
- `Anchor.toml` mainnet program/provider config
- `scripts/deploy-receipt-mainnet.mjs`
- `scripts/check-mainnet-receipt-consistency.mjs`
- `deployments/mainnet/receipt.idl.json`
- `deployments/mainnet/receipt.json`
- release/runbook documentation for mainnet receipt deployment

### Runtime Impact
- M19/M21+ runtime can depend on canonical mainnet receipt artifacts produced by this workflow
- no shadow-mode transaction submission is introduced by this milestone
- no receipt writes are performed by shadow mode as part of M20

## Implementation Plan

### Phase 1 — Config + Artifact Layout
- add mainnet config to Anchor
- define canonical `deployments/mainnet/` layout
- define manifest schema
- decide program-id handling strategy

### Phase 2 — Deployment Tooling
- implement `deploy-receipt-mainnet.mjs`
- implement artifact copy/generation
- implement deterministic manifest/hash generation

### Phase 3 — Verification Tooling
- implement `check-mainnet-receipt-consistency.mjs`
- validate on-chain existence and local artifact consistency
- add CI or scripted validation hooks where appropriate

### Phase 4 — Runbook + Governance
- document release procedure
- document rollback/failure procedure
- document upgrade authority ownership and intended next-state

## Test Plan

### Unit / Script-Level Tests
- manifest generation produces required fields
- IDL hash generation is stable
- script input validation fails on missing RPC, missing keypair, or missing output path
- consistency checker fails on:
  - wrong cluster
  - missing IDL
  - mismatched IDL hash
  - missing manifest
  - missing program account
  - program id mismatch

### Integration / Release Simulation
- test build + artifact generation against a non-mainnet rehearsal path where possible
- verify no source mutation occurs as part of the workflow
- verify canonical artifacts are created in expected locations
- verify consistency checker passes for a known-good artifact set

### Manual Release Validation
- deploy to mainnet using documented workflow
- run consistency checker successfully
- run `solana program show <PROGRAM_ID> --url mainnet-beta`
- confirm manifest and IDL are committed/stored according to release policy
- confirm upgrade authority matches documented expectation

## Risks
- accidental source mutation causing incorrect mainnet release provenance
- deploying with wrong program id or wrong cluster
- IDL drift between built artifact and committed manifest
- unclear upgrade authority causing operational or security failure
- false confidence from a deployment that lacks verification and artifact integrity

## Dependencies
- receipt program source remains minimal and deployable
- mainnet RPC and deployment credentials are available
- team agrees on upgrade-authority policy
- downstream runtime consumers use manifest-backed identity resolution

## Exit Criteria
M20 is complete when all of the following are true:
1. A mainnet receipt deployment can be performed from the repo through a documented, non-destructive workflow.
2. `deployments/mainnet/receipt.json` and `deployments/mainnet/receipt.idl.json` are produced as canonical artifacts.
3. A consistency script verifies on-chain program existence and local artifact integrity.
4. Upgrade authority ownership is explicit and documented.
5. The release runbook is complete enough for a second operator to reproduce the deployment without tribal knowledge.
6. The milestone leaves mainnet shadow dependent on canonical mainnet receipt artifacts, not hand-maintained guesses.

## Suggested Files
- `Anchor.toml`
- `scripts/deploy-receipt-mainnet.mjs`
- `scripts/check-mainnet-receipt-consistency.mjs`
- `deployments/mainnet/receipt.json`
- `deployments/mainnet/receipt.idl.json`
- `docs/runbook.md`
- `docs/release-receipt-mainnet.md` or equivalent

## Suggested Command Surface
- `pnpm receipt:build`
- `pnpm receipt:deploy:mainnet`
- `pnpm receipt:check:mainnet`

## Milestone Notes
M20 should be treated as the milestone that makes mainnet receipt deployment safe and repeatable.  
It should not absorb shadow-runner correctness work already assigned to M19.