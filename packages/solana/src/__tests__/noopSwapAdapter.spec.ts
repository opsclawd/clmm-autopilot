import { describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { NoopSwapAdapter } from '../swap/noop/NoopSwapAdapter';

const pk = (n: number) => new PublicKey(new Uint8Array(32).fill(n));

describe('NoopSwapAdapter', () => {
  it('returns zero-min-out quote and does not call network', async () => {
    const adapter = new NoopSwapAdapter();
    const originalFetch = (globalThis as { fetch?: unknown }).fetch;
    const fetchSpy = vi.fn();
    (globalThis as { fetch?: unknown }).fetch = fetchSpy;

    try {
      const quote = await adapter.getQuote({
        cluster: 'devnet',
        inMint: pk(1).toBase58(),
        outMint: pk(2).toBase58(),
        swapInAmount: 1000n,
        slippageBpsCap: 50,
        swapContext: {
          connection: {} as any,
          whirlpool: pk(3),
          tickSpacing: 1,
          tickCurrentIndex: 0,
          tickArrays: [pk(4), pk(5), pk(6)],
          tokenMintA: pk(7),
          tokenMintB: pk(8),
          tokenVaultA: pk(9),
          tokenVaultB: pk(10),
          tokenProgramA: pk(11),
          tokenProgramB: pk(12),
          aToB: true,
        },
      });

      expect(quote.router).toBe('noop');
      expect(quote.swapMinOutAmount).toBe(0n);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      (globalThis as { fetch?: unknown }).fetch = originalFetch;
    }
  });

  it('returns empty ixs and rejects router mismatch', async () => {
    const adapter = new NoopSwapAdapter();
    const context = {
      connection: {} as any,
      whirlpool: pk(3),
      tickSpacing: 1,
      tickCurrentIndex: 0,
      tickArrays: [pk(4), pk(5), pk(6)],
      tokenMintA: pk(7),
      tokenMintB: pk(8),
      tokenVaultA: pk(9),
      tokenVaultB: pk(10),
      tokenProgramA: pk(11),
      tokenProgramB: pk(12),
      aToB: true,
    };

    const ok = await adapter.buildSwapIxs(
      {
        router: 'noop',
        inMint: pk(1).toBase58(),
        outMint: pk(2).toBase58(),
        swapInAmount: 1n,
        swapMinOutAmount: 0n,
        slippageBpsCap: 50,
        quotedAtUnixSec: 1,
      },
      pk(13),
      context,
    );
    expect(ok.instructions).toEqual([]);
    expect(ok.lookupTableAddresses).toEqual([]);

    await expect(
      adapter.buildSwapIxs(
        {
          router: 'orca',
          inMint: pk(1).toBase58(),
          outMint: pk(2).toBase58(),
          swapInAmount: 1n,
          swapMinOutAmount: 0n,
          slippageBpsCap: 50,
          quotedAtUnixSec: 1,
        },
        pk(13),
        context,
      ),
    ).rejects.toMatchObject({ code: 'DATA_UNAVAILABLE' });
  });
});
