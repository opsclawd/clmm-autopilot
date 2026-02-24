import { describe, expect, it } from 'vitest';
import { classifySimulationFailure } from '../simErrors';

describe('classifySimulationFailure', () => {
  it('maps missing account to DATA_UNAVAILABLE', () => {
    const out = classifySimulationFailure({ err: 'AccountNotFound', logs: ['could not find account'] });
    expect(out.code).toBe('DATA_UNAVAILABLE');
  });

  it('maps invalid owner/constraint to INVALID_POSITION', () => {
    const out = classifySimulationFailure({ err: 'custom', logs: ['invalid account owner'] });
    expect(out.code).toBe('INVALID_POSITION');
  });

  it('maps slippage failures to SLIPPAGE_EXCEEDED', () => {
    const out = classifySimulationFailure({ err: 'slippage exceeded', logs: [] });
    expect(out.code).toBe('SLIPPAGE_EXCEEDED');
  });
});
