import { describe, expect, it } from 'vitest';
import { normalizeSolanaError } from '../errors';

describe('normalizeSolanaError', () => {
  it('maps known failures', () => {
    expect(normalizeSolanaError(new Error('blockhash not found')).code).toBe('BLOCKHASH_EXPIRED');
    expect(normalizeSolanaError(new Error('simulation failed')).code).toBe('SIMULATION_FAILED');
    expect(normalizeSolanaError(new Error('slippage exceeded')).code).toBe('SLIPPAGE_EXCEEDED');
    expect(normalizeSolanaError(new Error('429 rate limit')).code).toBe('RPC_TRANSIENT');
  });

  it('falls back to permanent rpc error', () => {
    expect(normalizeSolanaError('weird unknown')).toEqual({
      code: 'RPC_PERMANENT',
      message: 'weird unknown',
      retryable: false,
    });
  });
});
