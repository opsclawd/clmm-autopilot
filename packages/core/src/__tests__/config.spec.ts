import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, getDefaultConfig, validateConfig } from '../config';

describe('validateConfig', () => {
  it('defaults when input is undefined', () => {
    const res = validateConfig(undefined);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual(DEFAULT_CONFIG);
  });

  it('rejects non-object root input', () => {
    const res = validateConfig('bad-root');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors[0]?.path).toBe('$');
      expect(res.errors[0]?.code).toBe('TYPE');
    }
  });

  it('rejects invalid cluster enum', () => {
    const res = validateConfig({ cluster: 'stagingnet' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors[0]?.path).toBe('cluster');
      expect(res.errors[0]?.code).toBe('RANGE');
    }
  });

  it('rejects slippage above 50 bps', () => {
    const res = validateConfig({ execution: { slippageBpsCap: 51 } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors[0]?.path).toBe('execution.slippageBpsCap');
      expect(res.errors[0]?.code).toBe('RANGE');
    }
  });

  it('rejects negative cooldown', () => {
    const res = validateConfig({ policy: { cooldownMs: -1 } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors[0]?.path).toBe('policy.cooldownMs');
      expect(res.errors[0]?.code).toBe('RANGE');
    }
  });

  it('rejects invalid cadence semantics (must be > 0)', () => {
    const res = validateConfig({ policy: { cadenceMs: 0 } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.find((e) => e.path === 'policy.cadenceMs')?.code).toBe('RANGE');
    }
  });

  it('rejects non-coercible numeric strings', () => {
    const res = validateConfig({ policy: { cadenceMs: 'abc' } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const err = res.errors.find((e) => e.path === 'policy.cadenceMs');
      expect(err?.code).toBe('TYPE');
    }
  });

  it('rejects bad backoff schedule', () => {
    const res = validateConfig({ execution: { retryBackoffMs: [250, 200, 750] } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const err = res.errors.find((e) => e.path === 'execution.retryBackoffMs');
      expect(err?.code).toBe('INVALID_BACKOFF_SCHEDULE');
    }
  });

  it('rejects non-coercible backoff entries', () => {
    const res = validateConfig({ execution: { retryBackoffMs: [250, 'oops', 750] } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const err = res.errors.find((e) => e.path === 'execution.retryBackoffMs[1]');
      expect(err?.code).toBe('TYPE');
    }
  });

  it('requires compute budget settings to be set/unset together', () => {
    // Setting one side while explicitly unsetting the other should be rejected.
    const res = validateConfig({ execution: { computeUnitLimit: 600000, computeUnitPriceMicroLamports: null } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.path === 'execution.computeUnitLimit' && e.code === 'RANGE')).toBe(true);
    }
  });

  it('rejects invalid receipt polling config', () => {
    const res = validateConfig({ execution: { receiptPollMaxAttempts: 0, receiptPollIntervalMs: -1 } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.path === 'execution.receiptPollMaxAttempts')).toBe(true);
      expect(res.errors.some((e) => e.path === 'execution.receiptPollIntervalMs')).toBe(true);
    }
  });

  it('accepts numeric strings (normalize)', () => {
    const res = validateConfig({ policy: { cadenceMs: '2000' }, execution: { slippageBpsCap: '50', quoteFreshnessSec: '20' } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.policy.cadenceMs).toBe(2000);
      expect(res.value.execution.slippageBpsCap).toBe(50);
      expect(res.value.execution.quoteFreshnessSec).toBe(20);
    }
  });

  it('defaults swapRouter by cluster', () => {
    const mainnet = validateConfig({ cluster: 'mainnet-beta' });
    expect(mainnet.ok).toBe(true);
    if (mainnet.ok) {
      expect(mainnet.value.execution.swapRouter).toBe('jupiter');
      expect(mainnet.value.operator.runtimeMode).toBe('dry-run');
      expect(mainnet.value.receiptProgramId).toBeUndefined();
    }

    const local = validateConfig({ cluster: 'localnet' });
    expect(local.ok).toBe(true);
    if (local.ok) {
      expect(local.value.execution.swapRouter).toBe('noop');
      expect(local.value.operator.runtimeMode).toBe('dry-run');
    }
  });

  it('exposes default ui.sampleBufferSize', () => {
    const res = validateConfig(undefined);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.ui.sampleBufferSize).toBe(DEFAULT_CONFIG.ui.sampleBufferSize);
      expect(res.value.operator.runtimeMode).toBe('simulate-only');
    }
  });

  it('derives cluster-specific defaults without leaking devnet receipt identity', () => {
    const mainnet = getDefaultConfig('mainnet-beta');
    expect(mainnet.operator.runtimeMode).toBe('dry-run');
    expect(mainnet.receiptProgramId).toBeUndefined();

    const devnet = getDefaultConfig('devnet');
    expect(devnet.operator.runtimeMode).toBe('simulate-only');
    expect(devnet.receiptProgramId).toBeDefined();
  });

  it('rejects invalid ui.sampleBufferSize', () => {
    const res = validateConfig({ ui: { sampleBufferSize: 0 } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.path === 'ui.sampleBufferSize' && e.code === 'RANGE')).toBe(true);
    }
  });

  it('validates fallback receipt identity fields', () => {
    const ok = validateConfig({
      receiptProgramId: 'A81Xsuwg5zrT1sgvkncemfWqQ8nymwHS3e7ExM4YnXMm',
      receiptIdlHashMode: 'full-v1',
      receiptIdlHash: 'a'.repeat(64),
      receiptIdlPath: 'deployments/devnet/receipt.idl.json',
    });
    expect(ok.ok).toBe(true);

    const badHash = validateConfig({ receiptIdlHash: 'xyz' });
    expect(badHash.ok).toBe(false);
    if (!badHash.ok) {
      expect(badHash.errors.some((e) => e.path === 'receiptIdlHash')).toBe(true);
    }

    const badMode = validateConfig({ receiptIdlHashMode: 'subset-v1' });
    expect(badMode.ok).toBe(false);
    if (!badMode.ok) {
      expect(badMode.errors.some((e) => e.path === 'receiptIdlHashMode')).toBe(true);
    }

    const devnetNoFallback = validateConfig({
      cluster: 'devnet',
      receiptProgramId: undefined,
      receiptIdlHashMode: undefined,
      receiptIdlHash: undefined,
      receiptIdlPath: undefined,
    });
    expect(devnetNoFallback.ok).toBe(true);

    const partialFallback = validateConfig({
      cluster: 'devnet',
      receiptProgramId: 'A81Xsuwg5zrT1sgvkncemfWqQ8nymwHS3e7ExM4YnXMm',
      receiptIdlHashMode: undefined,
      receiptIdlHash: undefined,
      receiptIdlPath: undefined,
    });
    expect(partialFallback.ok).toBe(true);

    const badProgramId = validateConfig({
      cluster: 'devnet',
      receiptProgramId: 'not-a-pubkey!',
    });
    expect(badProgramId.ok).toBe(false);
    if (!badProgramId.ok) {
      expect(badProgramId.errors.some((e) => e.path === 'receiptProgramId')).toBe(true);
    }
  });

  it('rejects invalid operator fields', () => {
    const badMode = validateConfig({
      operator: {
        runtimeMode: 'unsafe-mode',
      },
    });
    expect(badMode.ok).toBe(false);
    if (!badMode.ok) {
      expect(badMode.errors.some((e) => e.path === 'operator.runtimeMode')).toBe(true);
    }

    const badPauseFlag = validateConfig({
      operator: {
        executionPausedDefault: 'yes',
      },
    });
    expect(badPauseFlag.ok).toBe(false);
    if (!badPauseFlag.ok) {
      expect(badPauseFlag.errors.some((e) => e.path === 'operator.executionPausedDefault')).toBe(true);
    }
  });

  it('rejects noop router on mainnet', () => {
    const res = validateConfig({
      cluster: 'mainnet-beta',
      execution: { swapRouter: 'noop' },
      operator: { runtimeMode: 'execute', executionPausedDefault: false },
      receiptProgramId: 'A81Xsuwg5zrT1sgvkncemfWqQ8nymwHS3e7ExM4YnXMm',
      receiptIdlHashMode: 'full-v1',
      receiptIdlHash: 'a'.repeat(64),
      receiptIdlPath: 'deployments/mainnet/receipt.idl.json',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.path === 'execution.swapRouter')).toBe(true);
    }
  });

  it('requires receipt identity for execute mode outside devnet', () => {
    const res = validateConfig({
      cluster: 'mainnet-beta',
      operator: { runtimeMode: 'execute', executionPausedDefault: false },
      execution: { swapRouter: 'jupiter' },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.path === 'receiptProgramId')).toBe(true);
    }
  });
});
