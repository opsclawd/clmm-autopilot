import { describe, expect, it } from 'vitest';
import { unixDaysFromUnixMs, unixDaysFromUnixTs } from '../epoch';

describe('epoch canonical helpers', () => {
  it('computes unixDays from unixTs', () => {
    expect(unixDaysFromUnixTs(0)).toBe(0);
    expect(unixDaysFromUnixTs(86399)).toBe(0);
    expect(unixDaysFromUnixTs(86400)).toBe(1);
  });

  it('computes unixDays from unixMs', () => {
    expect(unixDaysFromUnixMs(0)).toBe(0);
    expect(unixDaysFromUnixMs(86_399_999)).toBe(0);
    expect(unixDaysFromUnixMs(86_400_000)).toBe(1);
  });
});
