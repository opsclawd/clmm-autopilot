import { describe, expect, it } from 'vitest';
import { createConsoleNotificationsAdapter } from '../index';

describe('notifications adapter', () => {
  it('exposes structured emit and compatibility helpers', () => {
    const adapter = createConsoleNotificationsAdapter();
    expect(typeof adapter.emit).toBe('function');
    expect(typeof adapter.notify).toBe('function');
    expect(typeof adapter.notifyError).toBe('function');
  });
});
