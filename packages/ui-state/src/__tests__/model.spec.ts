import { describe, expect, it } from 'vitest';
import { buildUiModel, mapErrorToUi } from '../index';

describe('ui-state', () => {
  it('blocks execute on HOLD without forcing an error banner', () => {
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
    expect(model.lastError).toBeUndefined();
  });

  it('enables execute on TRIGGER only when pair validation is true', () => {
    const blocked = buildUiModel({
      decision: {
        decision: 'TRIGGER_DOWN',
        reasonCode: 'BREAK_CONFIRMED',
        samplesUsed: 3,
        threshold: 3,
        cooldownRemainingMs: 12000,
      },
    });
    expect(blocked.canExecute).toBe(false);

    const model = buildUiModel({
      snapshot: {
        positionAddress: 'pos',
        currentTick: 1,
        lowerTick: 0,
        upperTick: 2,
        inRange: false,
        pairLabel: 'SOL/USDC',
        pairValid: true,
      },
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

  it('surfaces config values used for policy + execution', () => {
    const model = buildUiModel({
      config: {
        policy: { cadenceMs: 2000, requiredConsecutive: 3, cooldownMs: 90000 },
        execution: { slippageBpsCap: 50, quoteFreshnessMs: 20000 },
      },
    });
    expect(model.config?.policy.cadenceMs).toBe(2000);
    expect(model.config?.policy.requiredConsecutive).toBe(3);
    expect(model.config?.policy.cooldownMs).toBe(90000);
    expect(model.config?.execution.slippageBpsCap).toBe(50);
    expect(model.config?.execution.quoteFreshnessMs).toBe(20000);
  });

  it('maps representative canonical errors', () => {
    expect(mapErrorToUi({ code: 'SIMULATION_FAILED' }).title).toBe('Simulation failed');
    expect(mapErrorToUi({ code: 'BLOCKHASH_EXPIRED' }).code).toBe('BLOCKHASH_EXPIRED');
    expect(mapErrorToUi({ code: 'CONFIG_INVALID' }).title).toBe('Invalid configuration');
  });

  it('renders actionable insufficient-fee-buffer details when debug payload is present', () => {
    const ui = mapErrorToUi({
      code: 'INSUFFICIENT_FEE_BUFFER',
      debug: {
        availableLamports: 100,
        deficitLamports: 23,
        requirements: { totalRequiredLamports: 123, ataCount: 1, rentLamports: 50, bufferLamports: 10 },
      },
    });
    expect(ui.message).toContain('available=100');
    expect(ui.message).toContain('required');
    expect(ui.message).toContain('deficit=23');
    expect(ui.debug).toContain('"availableLamports": 100');
  });
});
