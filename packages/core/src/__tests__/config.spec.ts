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

  it('rejects non-coercible numeric strings', () => {
    const res = validateConfig({ policy: { cadenceMs: 'abc' } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const err = res.errors.find((e) => e.path === 'policy.cadenceMs');
      expect(err?.code).toBe('TYPE');
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

  it('rejects non-coercible backoff entries', () => {
    const res = validateConfig({ reliability: { retryBackoffMs: [250, 'oops', 750] } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const err = res.errors.find((e) => e.path === 'reliability.retryBackoffMs[1]');
      expect(err?.code).toBe('TYPE');
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
