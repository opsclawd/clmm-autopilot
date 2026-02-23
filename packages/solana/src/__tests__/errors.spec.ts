import { describe, expect, it } from 'vitest';
import { normalizeSolanaError } from '../errors';

describe('normalizeSolanaError', () => {
  it('preserves canonical code when present', () => {
    expect(
      normalizeSolanaError({ code: 'ALREADY_EXECUTED_THIS_EPOCH', retryable: false, message: 'already done' }),
    ).toEqual({
      code: 'ALREADY_EXECUTED_THIS_EPOCH',
      retryable: false,
      message: 'already done',
    });
  });

  it('maps known failures', () => {
    expect(normalizeSolanaError(new Error('Blockhash not found')).code).toBe('BLOCKHASH_EXPIRED');
    expect(normalizeSolanaError(new Error('Transaction was not confirmed in 150 blocks')).code).toBe('BLOCKHASH_EXPIRED');
    expect(normalizeSolanaError(new Error('transaction simulation failed')).code).toBe('SIMULATION_FAILED');
    expect(normalizeSolanaError(new Error('slippage tolerance exceeded')).code).toBe('SLIPPAGE_EXCEEDED');
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
