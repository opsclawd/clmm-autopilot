import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '@clmm-autopilot/core';
import { PublicKey } from '@solana/web3.js';
import { buildShadowTriggerRecord } from '../mainnetShadow';

describe('buildShadowTriggerRecord', () => {
  it('persists the snapshot whirlpool address and explicit build status', () => {
    const authority = new PublicKey(new Uint8Array(32).fill(1));
    const params: Parameters<typeof buildShadowTriggerRecord>[0] = {
      sessionId: 'session-1',
      timestamp: '2026-03-13T00:00:00.000Z',
      config: {
        ...DEFAULT_CONFIG,
        cluster: 'mainnet',
        executionMode: 'mainnet-shadow',
        operator: {
          ...DEFAULT_CONFIG.operator,
          executionMode: 'mainnet-shadow',
          runtimeMode: 'simulate-only',
        },
      },
      authority,
      positionAddress: new PublicKey(new Uint8Array(32).fill(2)).toBase58(),
      positionSourceMode: 'configured' as const,
      refresh: {
        snapshot: {
          positionAddress: new PublicKey(new Uint8Array(32).fill(2)).toBase58(),
          whirlpoolAddress: new PublicKey(new Uint8Array(32).fill(3)).toBase58(),
          currentTick: 12,
          lowerTick: 10,
          upperTick: 20,
          inRange: false,
          pairLabel: 'SOL/USDC',
          pairValid: true,
          tokenProgramA: new PublicKey(new Uint8Array(32).fill(4)).toBase58(),
          tokenProgramB: new PublicKey(new Uint8Array(32).fill(5)).toBase58(),
        },
        decision: {
          decision: 'TRIGGER_UP' as const,
          reasonCode: 'OUT_OF_RANGE',
          samplesUsed: 3,
          threshold: 6000,
          cooldownRemainingMs: 0,
          nextState: {},
        },
        quote: {
          slippageBpsCap: 50,
          expectedMinOut: '1',
          quoteAgeMs: 10,
        },
      },
      result: {
        status: 'ERROR' as const,
        errorCode: 'SIMULATION_FAILED' as const,
        shadow: {
          txBuildStatus: 'BUILD_OK' as const,
          direction: 'trigger_up' as const,
          quoteSummary: {
            inAmount: '11',
            minOut: '22',
            slippageBps: 50,
            quoteAgeMs: 10,
          },
          candidateInstructionSummary: {
            removeLiquidityPlanned: true,
            collectFeesPlanned: true,
            swapInstructionCount: 2,
            receiptIxIncluded: false,
          },
          tokenProgramSummary: {
            mintAProgram: new PublicKey(new Uint8Array(32).fill(4)).toBase58(),
            mintBProgram: new PublicKey(new Uint8Array(32).fill(5)).toBase58(),
          },
          receiptPdaExpected: new PublicKey(new Uint8Array(32).fill(9)).toBase58(),
          receiptConfigValid: true,
          receiptStepStructurallyBuildable: true,
          receiptIxIncluded: false,
        },
      },
      simClass: 'SIM_UNKNOWN' as const,
      normalizedError: { code: 'SIMULATION_FAILED' as const },
    };

    const record = buildShadowTriggerRecord(params);

    expect(record.whirlpoolAddress).toBe(params.refresh.snapshot.whirlpoolAddress);
    expect(record.whirlpoolAddress).not.toBe(params.result.shadow!.receiptPdaExpected);
    expect(record.txBuildStatus).toBe('BUILD_OK');
  });
});
