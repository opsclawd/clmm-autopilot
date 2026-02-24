import { describe, expect, it } from 'vitest';
import type { Bounds, PolicyConfig, Sample } from '../policy';
import { evaluateRangeBreak } from '../policy';

const bounds: Bounds = { lowerTickIndex: 100, upperTickIndex: 200 };

const basePolicy: PolicyConfig = {
  requiredConsecutive: 3,
  cadenceMs: 1_000,
  cooldownMs: 10_000,
};

const s = (slot: number, unixTs: number, currentTickIndex: number): Sample => ({
  slot,
  unixTs,
  currentTickIndex,
});

describe('policy engine', () => {
  it('wick below lower then re-enters -> HOLD', () => {
    const decision = evaluateRangeBreak(
      [s(1, 1_000, 90), s(2, 1_001, 120), s(3, 1_002, 130)],
      bounds,
      basePolicy,
    );
    expect(decision.action).toBe('HOLD');
    expect(decision.reasonCode).toBe('IN_RANGE');
  });

  it('sustained below lower -> TRIGGER_DOWN', () => {
    const decision = evaluateRangeBreak(
      [s(1, 1_000, 95), s(2, 1_001, 94), s(3, 1_002, 93)],
      bounds,
      basePolicy,
    );
    expect(decision.action).toBe('TRIGGER_DOWN');
  });

  it('wick above upper then re-enters -> HOLD', () => {
    const decision = evaluateRangeBreak(
      [s(1, 1_000, 205), s(2, 1_001, 180), s(3, 1_002, 170)],
      bounds,
      basePolicy,
    );
    expect(decision.action).toBe('HOLD');
    expect(decision.reasonCode).toBe('IN_RANGE');
  });

  it('sustained above upper -> TRIGGER_UP', () => {
    const decision = evaluateRangeBreak(
      [s(1, 1_000, 205), s(2, 1_001, 206), s(3, 1_002, 207)],
      bounds,
      basePolicy,
    );
    expect(decision.action).toBe('TRIGGER_UP');
  });

  it('cooldown blocks subsequent triggers', () => {
    const first = evaluateRangeBreak(
      [s(1, 1_000, 95), s(2, 1_001, 94), s(3, 1_002, 93)],
      bounds,
      basePolicy,
    );
    expect(first.action).toBe('TRIGGER_DOWN');

    const second = evaluateRangeBreak(
      [s(4, 1_003, 92), s(5, 1_004, 91), s(6, 1_005, 90)],
      bounds,
      basePolicy,
      first.nextState,
    );

    expect(second.action).toBe('HOLD');
    expect(second.reasonCode).toBe('COOLDOWN_ACTIVE');
    expect(second.debug.cooldownRemainingMs).toBeGreaterThan(0);
  });

  it('missing data -> HOLD + DATA_UNAVAILABLE', () => {
    const decision = evaluateRangeBreak([], bounds, basePolicy);
    expect(decision.action).toBe('HOLD');
    expect(decision.reasonCode).toBe('DATA_UNAVAILABLE');
  });

  it('duplicate evaluation does not re-trigger', () => {
    const samples = [s(1, 1_000, 95), s(2, 1_001, 94), s(3, 1_002, 93)];
    const first = evaluateRangeBreak(samples, bounds, basePolicy);
    const second = evaluateRangeBreak(samples, bounds, basePolicy, first.nextState);

    expect(first.action).toBe('TRIGGER_DOWN');
    expect(second.action).toBe('HOLD');
    expect(second.reasonCode).toBe('DUPLICATE_EVALUATION');
  });

  it('shuffled samples -> identical decision', () => {
    const ordered = [s(1, 1_000, 95), s(2, 1_001, 94), s(3, 1_002, 93)];
    const shuffled = [ordered[2], ordered[0], ordered[1]];

    const a = evaluateRangeBreak(ordered, bounds, basePolicy);
    const b = evaluateRangeBreak(shuffled, bounds, basePolicy);

    expect(a).toEqual(b);
  });

  it('duplicates inside samples -> identical decision vs deduped', () => {
    const deduped = [s(1, 1_000, 95), s(2, 1_001, 94), s(3, 1_002, 93)];
    const withDupes = [deduped[0], deduped[1], deduped[1], deduped[2], deduped[2], deduped[2]];

    const a = evaluateRangeBreak(deduped, bounds, basePolicy);
    const b = evaluateRangeBreak(withDupes, bounds, basePolicy);

    expect(a).toEqual(b);
  });

  it('sampling gaps larger than cadence break consecutive streaks', () => {
    const decision = evaluateRangeBreak(
      [s(1, 1_000, 95), s(2, 1_005, 94), s(3, 1_010, 93)],
      bounds,
      basePolicy,
    );

    expect(decision.action).toBe('HOLD');
    expect(decision.reasonCode).toBe('DEBOUNCE_NOT_MET');
  });

  it('non-monotonic latest sample relative to last state does not trigger', () => {
    const decision = evaluateRangeBreak(
      [s(1, 1_000, 95), s(2, 1_001, 94), s(3, 1_002, 93)],
      bounds,
      basePolicy,
      { lastEvaluatedSample: s(5, 1_010, 150) },
    );

    expect(decision.action).toBe('HOLD');
    expect(decision.reasonCode).toBe('NON_MONOTONIC_SAMPLE');
  });

  it('invariants: deterministic + never both triggers', () => {
    const input = [s(1, 1_000, 205), s(2, 1_001, 206), s(3, 1_002, 207)];
    const a = evaluateRangeBreak(input, bounds, basePolicy);
    const b = evaluateRangeBreak(input, bounds, basePolicy);

    expect(a).toEqual(b);
    expect(['HOLD', 'TRIGGER_DOWN', 'TRIGGER_UP']).toContain(a.action);
  });
});
