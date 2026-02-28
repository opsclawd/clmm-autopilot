import { describe, expect, it } from 'vitest';
import { getSwapAdapter } from '../swap/registry';

describe('getSwapAdapter', () => {
  it('rejects unsupported router/cluster combos', () => {
    expect(() => getSwapAdapter('jupiter', 'devnet')).toThrowError(
      expect.objectContaining({ code: 'SWAP_ROUTER_UNSUPPORTED_CLUSTER' }),
    );
    expect(() => getSwapAdapter('orca', 'localnet')).toThrowError(
      expect.objectContaining({ code: 'SWAP_ROUTER_UNSUPPORTED_CLUSTER' }),
    );
  });

  it('returns supported adapters', () => {
    expect(getSwapAdapter('jupiter', 'mainnet-beta').name).toBe('jupiter');
    expect(getSwapAdapter('orca', 'devnet').name).toBe('orca');
    expect(getSwapAdapter('noop', 'devnet').name).toBe('noop');
    expect(getSwapAdapter('noop', 'mainnet-beta').name).toBe('noop');
    expect(getSwapAdapter('noop', 'localnet').name).toBe('noop');
  });
});
