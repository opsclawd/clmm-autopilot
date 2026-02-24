# M10 — Single authoritative config (policy + execution + UI)

## Goal

Remove hardcoded parameters scattered across apps and packages. Make MVP tunable and testable by loading a single typed config.

## Scope

### In scope

- packages/core exports AutopilotConfig (single interface) covering:
  - cluster (enum)
  - policy:
    - cadenceMs
    - requiredConsecutive
    - cooldownMs
  - execution:
    - slippageBpsCap
    - feeBufferLamports
    - computeUnitLimit (optional)
    - computeUnitPriceMicroLamports (optional)
    - quoteFreshnessMs
    - quoteFreshnessSlots
    - rebuildTickDelta (default 1 * tickSpacing)
    - maxRetries + backoff schedule
    - minSwapAmount thresholds:
      - minSolLamportsToSwap
      - minUsdcMinorToSwap
- Config loading:
  - web: apps/web/src/config.ts reads env + defaults.
  - mobile: apps/mobile/src/config.ts uses constants + optional build-time env.
  - both must produce identical AutopilotConfig shape.
- UI must display:
  - cadence / requiredConsecutive / cooldown
  - slippage cap
  - quote freshness
- Remove any “magic numbers” in execution path; only config values.

### Out of scope

- Remote config service
- Per-position config profiles

## Required deliverables

- packages/core/src/config.ts:
  - AutopilotConfig type
  - DEFAULT_CONFIG
  - validateConfig(config) -> normalized errors
- packages/solana:
  - All reliability + builder paths take config: AutopilotConfig only.
- Apps:
  - Provide config once at app root and pass through typed state model.

## Tests

- Unit tests for validateConfig:
  - invalid slippage cap, negative cooldown, missing cadence
- Snapshot/UI state:
  - ensure displayed values match config.

## Acceptance criteria (pass/fail)

Pass only if:

1. There are no remaining hardcoded policy/execution constants in runtime paths.
2. Config is validated once and failures are mapped to canonical errors.
3. UI displays the same values used by the builder/policy engine.
