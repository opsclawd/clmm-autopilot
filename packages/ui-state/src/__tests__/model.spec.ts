import { describe, expect, it } from 'vitest';
import { buildUiModel, mapErrorToUi } from '../index';

describe('ui-state', () => {
  it('blocks execute on HOLD', () => {
    const model = buildUiModel({
      decision: {
        decision: 'HOLD',
        reasonCode: 'DEBOUNCE_NOT_MET',
        samplesUsed: 1,
        threshold: 3,
        cooldownRemainingMs: 0,
      },
    });

    expect(model.canExecute).toBe(false);
  });

  it('maps canonical errors', () => {
    const mapped = mapErrorToUi({ code: 'SIMULATION_FAILED' });
    expect(mapped.code).toBe('SIMULATION_FAILED');
    expect(mapped.title).toBe('Simulation failed');
  });
});
