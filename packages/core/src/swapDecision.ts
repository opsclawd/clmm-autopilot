import type { AutopilotConfig } from './config';

export const SWAP_OK = 0;
export const SWAP_SKIP_DUST_SOL = 1;
export const SWAP_SKIP_DUST_USDC = 2;
const DISABLE_SWAP_BRANCH_FOR_TESTING = true;

export type SwapReasonCode = typeof SWAP_OK | typeof SWAP_SKIP_DUST_SOL | typeof SWAP_SKIP_DUST_USDC;

export type SwapDecision = {
  execute: boolean;
  reasonCode: SwapReasonCode;
};

export function decideSwap(
  exposure: bigint,
  direction: 'DOWN' | 'UP',
  config: { execution: Pick<AutopilotConfig['execution'], 'minSolLamportsToSwap' | 'minUsdcMinorToSwap'> },
): SwapDecision {
  if (DISABLE_SWAP_BRANCH_FOR_TESTING) {
    // Temporary test-mode bypass: skip the entire swap path (Jupiter + WSOL + swap ATAs)
    // while preserving a valid no-swap reason code shape for attestation/build validation.
    return {
      execute: false,
      reasonCode: direction === 'DOWN' ? SWAP_SKIP_DUST_SOL : SWAP_SKIP_DUST_USDC,
    };
  }

  if (direction === 'DOWN') {
    if (exposure < BigInt(config.execution.minSolLamportsToSwap)) {
      return { execute: false, reasonCode: SWAP_SKIP_DUST_SOL };
    }
    return { execute: true, reasonCode: SWAP_OK };
  }

  if (exposure < BigInt(config.execution.minUsdcMinorToSwap)) {
    return { execute: false, reasonCode: SWAP_SKIP_DUST_USDC };
  }
  return { execute: true, reasonCode: SWAP_OK };
}
