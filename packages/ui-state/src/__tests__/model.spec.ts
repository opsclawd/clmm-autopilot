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

  it('enables execute on TRIGGER and keeps debounce/cooldown fields', () => {
    const model = buildUiModel({
      decision: {
        decision: 'TRIGGER_DOWN',
        reasonCode: 'BREAK_CONFIRMED',
        samplesUsed: 3,
        threshold: 3,
        cooldownRemainingMs: 12000,
      },
    });
    expect(model.canExecute).toBe(true);
    expect(model.decision?.samplesUsed).toBe(3);
    expect(model.decision?.cooldownRemainingMs).toBe(12000);
  });

  it('maps representative canonical errors', () => {
    expect(mapErrorToUi({ code: 'SIMULATION_FAILED' }).title).toBe('Simulation failed');
    expect(mapErrorToUi({ code: 'BLOCKHASH_EXPIRED' }).code).toBe('BLOCKHASH_EXPIRED');
  });
});
