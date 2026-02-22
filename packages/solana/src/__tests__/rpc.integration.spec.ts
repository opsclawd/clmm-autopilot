import { describe, expect, it } from 'vitest';
import { createReadonlyRpc } from '../rpc';

describe('readonly rpc wrapper (deterministic)', () => {
  it('creates a stable surface', () => {
    const rpc = createReadonlyRpc({
      rpcUrl: 'https://api.devnet.solana.com',
      cluster: 'devnet',
      commitment: 'confirmed',
    });

    expect(typeof rpc.getSlot).toBe('function');
    expect(typeof rpc.getLatestBlockhash).toBe('function');
    expect(typeof rpc.getAccountInfoExists).toBe('function');
    expect(typeof rpc.getMultipleAccountsInfoExists).toBe('function');
    expect(typeof rpc.getSignaturesForAddress).toBe('function');
    expect(typeof rpc.getTransaction).toBe('function');
    expect(typeof rpc.getBlockTime).toBe('function');
  });

  it.skipIf(process.env.RUN_DEVNET_TESTS !== '1')('optional devnet smoke', async () => {
    const rpc = createReadonlyRpc({
      rpcUrl: 'https://api.devnet.solana.com',
      cluster: 'devnet',
      commitment: 'confirmed',
    });

    const slot = await rpc.getSlot();
    expect(slot).toBeGreaterThan(0);
  });
});
