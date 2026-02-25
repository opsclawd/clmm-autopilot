import { describe, expect, it } from 'vitest';
import { decideSwap, SWAP_OK, SWAP_SKIP_DUST_SOL, SWAP_SKIP_DUST_USDC } from '../swapDecision';

describe('decideSwap', () => {
  const config = {
    execution: {
      minSolLamportsToSwap: 10_000,
      minUsdcMinorToSwap: 5_000,
    },
  };

  it('DOWN skips when SOL exposure is below threshold', () => {
    expect(decideSwap(9_999n, 'DOWN', config)).toEqual({ execute: false, reasonCode: SWAP_SKIP_DUST_SOL });
  });

  it('DOWN executes when SOL exposure is at/above threshold', () => {
    expect(decideSwap(10_000n, 'DOWN', config)).toEqual({ execute: true, reasonCode: SWAP_OK });
  });

  it('UP skips when USDC exposure is below threshold', () => {
    expect(decideSwap(4_999n, 'UP', config)).toEqual({ execute: false, reasonCode: SWAP_SKIP_DUST_USDC });
  });

  it('UP executes when USDC exposure is at/above threshold', () => {
    expect(decideSwap(5_000n, 'UP', config)).toEqual({ execute: true, reasonCode: SWAP_OK });
  });
});
