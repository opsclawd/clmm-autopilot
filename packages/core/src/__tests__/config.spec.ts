import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, validateConfig } from '../config';

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

  it('accepts numeric strings (normalize)', () => {
    const res = validateConfig({ policy: { cadenceMs: '2000' }, execution: { slippageBpsCap: '50' } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.policy.cadenceMs).toBe(2000);
      expect(res.value.execution.slippageBpsCap).toBe(50);
    }
  });
});
