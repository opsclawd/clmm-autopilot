import { describe, expect, it } from 'vitest';
import { loadSolanaConfig } from '../config';

describe('loadSolanaConfig', () => {
  it('uses defaults', () => {
    expect(loadSolanaConfig({})).toEqual({
      rpcUrl: 'https://api.devnet.solana.com',
      cluster: 'devnet',
      commitment: 'confirmed',
    });
  });

  it('rejects invalid values', () => {
    expect(() => loadSolanaConfig({ SOLANA_CLUSTER: 'staging' })).toThrow();
    expect(() => loadSolanaConfig({ SOLANA_COMMITMENT: 'fast' })).toThrow();
    expect(() => loadSolanaConfig({ SOLANA_RPC_URL: 'ws://bad' })).toThrow();
  });
});
