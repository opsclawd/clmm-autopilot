import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '@clmm-autopilot/core';
import { deriveEffectiveOperatorState, enforceExecutionGate, validateRuntimeEnvironment } from '../runtime';

describe('runtime guardrails', () => {
  it('derives effective paused state from override then config default', () => {
    expect(deriveEffectiveOperatorState(DEFAULT_CONFIG).executionPaused).toBe(false);
    expect(deriveEffectiveOperatorState(DEFAULT_CONFIG, true).executionPaused).toBe(true);
  });

  it('validates rpc url shape', () => {
    expect(() => validateRuntimeEnvironment({ rpcUrl: 'https://api.devnet.solana.com' })).not.toThrow();
    expect(() => validateRuntimeEnvironment({ rpcUrl: '' })).toThrow(/RPC URL is required/);
    expect(() => validateRuntimeEnvironment({ rpcUrl: 'ws://bad' })).toThrow(/Invalid RPC URL protocol/);
  });

  it('requires wallet signing support for execute mode', () => {
    expect(() =>
      enforceExecutionGate({
        config: { ...DEFAULT_CONFIG, operator: { ...DEFAULT_CONFIG.operator, runtimeMode: 'execute' } },
        runtimeEnvironment: {
          rpcUrl: 'https://api.devnet.solana.com',
          walletConnected: false,
          signingAvailable: false,
        },
        requireSigning: true,
      }),
    ).toThrow(/connected wallet\/provider/i);
  });
});
