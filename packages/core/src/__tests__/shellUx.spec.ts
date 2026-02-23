import { describe, expect, it } from 'vitest';
import { buildShellUiState } from '../shellUx';

describe('buildShellUiState', () => {
  it('maps HOLD into blocked execute state with debounce progress', () => {
    const ui = buildShellUiState({
      decision: {
        action: 'HOLD',
        reasonCode: 'DEBOUNCE_NOT_MET',
        debug: { samplesUsed: 2, threshold: 6000, cooldownRemainingMs: 0 },
        nextState: {},
      },
      quote: { slippageCapBps: 50, expectedMinOut: '1000', quoteAgeMs: 100 },
      snapshot: { currentTickIndex: 100, lowerTickIndex: 80, upperTickIndex: 120 },
    });

    expect(ui.canExecute).toBe(false);
    expect(ui.debounceProgress).toBe('2/3');
  });

  it('maps trigger decision to executable state', () => {
    const ui = buildShellUiState({
      decision: {
        action: 'TRIGGER_DOWN',
        reasonCode: 'TRIGGER_DOWN_CONSECUTIVE',
        debug: { samplesUsed: 3, threshold: 6000, cooldownRemainingMs: 0 },
        nextState: {},
      },
      quote: { slippageCapBps: 50, expectedMinOut: '900', quoteAgeMs: 250 },
      snapshot: { currentTickIndex: 70, lowerTickIndex: 80, upperTickIndex: 120 },
    });

    expect(ui.canExecute).toBe(true);
    expect(ui.debounceProgress).toBe('3/3');
  });
});
