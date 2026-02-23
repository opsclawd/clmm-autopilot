import { describe, expect, it } from 'vitest';
import { createConsoleNotificationsAdapter } from '../index';

describe('notifications adapter', () => {
  it('exposes notify and notifyError', () => {
    const adapter = createConsoleNotificationsAdapter();
    expect(typeof adapter.notify).toBe('function');
    expect(typeof adapter.notifyError).toBe('function');
  });
});
