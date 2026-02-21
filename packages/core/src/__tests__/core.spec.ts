import { describe, expect, it } from 'vitest';
import { clamp, hasConsecutive, movingAverage } from '../index';

describe('core math helpers', () => {
  it('clamp and movingAverage behave deterministically', () => {
    expect(clamp(10, 0, 5)).toBe(5);
    expect(clamp(-10, 0, 5)).toBe(0);
    expect(clamp(3, 0, 5)).toBe(3);
    expect(() => clamp(1, 5, 0)).toThrow();

    expect(movingAverage([2])).toBe(2);
    expect(movingAverage([2, 4, 6])).toBe(4);
    expect(movingAverage([1, 1, 1, 1])).toBe(1);
  });

  it('hasConsecutive detects streaks correctly', () => {
    expect(hasConsecutive(['HOLD', 'DOWN', 'DOWN', 'DOWN'], 'DOWN', 3)).toBe(true);
    expect(hasConsecutive(['DOWN', 'UP', 'DOWN', 'DOWN'], 'DOWN', 3)).toBe(false);
    expect(hasConsecutive([1, 1, 2, 1, 1, 1], 1, 3)).toBe(true);
    expect(hasConsecutive([1, 2, 3], 4, 1)).toBe(false);
    expect(hasConsecutive([1, 2, 3], 1, 0)).toBe(true);
  });
});
