import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, validateConfig } from '../config';

describe('validateConfig', () => {
  it('defaults when input is undefined', () => {
    const res = validateConfig(undefined);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual(DEFAULT_CONFIG);
  });

  it('rejects slippage above 50 bps', () => {
    const res = validateConfig({ execution: { maxSlippageBps: 51 } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors[0]?.path).toBe('execution.maxSlippageBps');
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

  it('rejects invalid cadence', () => {
    const res = validateConfig({ policy: { cadenceMs: 0 } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors[0]?.path).toBe('policy.cadenceMs');
    }
  });

  it('rejects bad backoff schedule', () => {
    const res = validateConfig({ reliability: { retryBackoffMs: [250, 200, 750] } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const err = res.errors.find((e) => e.path === 'reliability.retryBackoffMs');
      expect(err?.code).toBe('INVALID_BACKOFF_SCHEDULE');
    }
  });

  it('accepts numeric strings (normalize)', () => {
    const res = validateConfig({ policy: { cadenceMs: '2000' }, execution: { maxSlippageBps: '50' } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.policy.cadenceMs).toBe(2000);
      expect(res.value.execution.maxSlippageBps).toBe(50);
    }
  });
});
