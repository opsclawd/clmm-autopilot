import { describe, expect, it } from 'vitest';
import { classifyShadowSimulationResult } from '../shadowSimulation';

describe('classifyShadowSimulationResult', () => {
  it('maps simulated success to SIM_OK', () => {
    expect(classifyShadowSimulationResult({ status: 'SIMULATED', error: null })).toBe('SIM_OK');
  });

  it('maps quote staleness to SIM_QUOTE_STALE', () => {
    expect(
      classifyShadowSimulationResult({
        status: 'ERROR',
        error: { code: 'QUOTE_STALE', message: 'stale', retryable: true },
      }),
    ).toBe('SIM_QUOTE_STALE');
  });

  it('maps receipt configuration issues to SIM_RECEIPT_CONFIG_ERROR', () => {
    expect(
      classifyShadowSimulationResult({
        status: 'ERROR',
        error: {
          code: 'RECEIPT_CONFIG_INCOMPLETE_FOR_SHADOW',
          message: 'missing',
          retryable: false,
        },
      }),
    ).toBe('SIM_RECEIPT_CONFIG_ERROR');
  });

  it('maps generic unknown errors to SIM_UNKNOWN', () => {
    expect(
      classifyShadowSimulationResult({
        status: 'ERROR',
        error: { code: 'CONFIG_INVALID', message: 'bad', retryable: false },
      }),
    ).toBe('SIM_UNKNOWN');
  });
});
