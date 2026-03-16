import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '@clmm-autopilot/core';
import { PublicKey } from '@solana/web3.js';
import { buildShadowTriggerRecord, isFatalShadowStartupCode, loadShadowConfig } from '../mainnetShadow';

const MAINNET_MANIFEST_FIXTURE = 'packages/solana/src/__tests__/fixtures/mainnet-receipt-manifest.json';

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

describe('loadShadowConfig', () => {
  it('hydrates missing receipt identity from the configured mainnet manifest', () => {
    const config = loadShadowConfig({
      RECEIPT_MANIFEST_PATH: MAINNET_MANIFEST_FIXTURE,
    });

    expect(config.cluster).toBe('mainnet');
    expect(config.executionMode).toBe('mainnet-shadow');
    expect(config.receiptProgramId).toBe('A81Xsuwg5zrT1sgvkncemfWqQ8nymwHS3e7ExM4YnXMm');
    expect(config.receiptIdlPath).toBe('deployments/devnet/receipt.idl.json');
  });

  it('fails fast when an explicit receipt manifest path is invalid', () => {
    expect(() =>
      loadShadowConfig({
        RECEIPT_MANIFEST_PATH: 'packages/solana/src/__tests__/fixtures/does-not-exist.json',
      }),
    ).toThrow(/manifest identity could not be loaded/);
  });

  it('fails fast when neither manifest nor config provides mainnet receipt identity', () => {
    expect(() => loadShadowConfig({})).toThrow(/receipt identity must be configured/i);
  });
});

describe('isFatalShadowStartupCode', () => {
  it('marks receipt identity failures as fatal to the shadow runner', () => {
    expect(isFatalShadowStartupCode('RECEIPT_CONFIG_INCOMPLETE_FOR_SHADOW')).toBe(true);
    expect(isFatalShadowStartupCode('RECEIPT_IDL_MISMATCH')).toBe(true);
    expect(isFatalShadowStartupCode('SIMULATION_FAILED')).toBe(false);
  });
});
