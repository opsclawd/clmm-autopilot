import { describe, expect, it, vi } from 'vitest';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';

vi.mock('../jupiter', () => ({
  fetchJupiterQuote: vi.fn(async () => ({
    inputMint: new PublicKey(new Uint8Array(32).fill(1)),
    outputMint: new PublicKey(new Uint8Array(32).fill(2)),
    inAmount: 10n,
    outAmount: 20n,
    slippageBps: 50,
    quotedAtUnixMs: 1_700_000_000_000,
    raw: { route: 'mock' },
  })),
  fetchJupiterSwapIxs: vi.fn(async () => ({
    instructions: [
      new TransactionInstruction({
        programId: new PublicKey(new Uint8Array(32).fill(3)),
        keys: [],
        data: Buffer.alloc(0),
      }),
    ],
    lookupTableAddresses: [new PublicKey(new Uint8Array(32).fill(4))],
  })),
}));

import { JupiterSwapApiAdapter } from '../swap/jupiter/JupiterSwapApiAdapter';
import { fetchJupiterSwapIxs } from '../jupiter';

const pk = (n: number) => new PublicKey(new Uint8Array(32).fill(n));

describe('JupiterSwapApiAdapter', () => {
  it('forwards swap instructions and lookup table addresses', async () => {
    const adapter = new JupiterSwapApiAdapter();
    const result = await adapter.buildSwapIxs(
      {
        router: 'jupiter',
        inMint: pk(1).toBase58(),
        outMint: pk(2).toBase58(),
        swapInAmount: 1000n,
        swapMinOutAmount: 900n,
        slippageBpsCap: 50,
        quotedAtUnixSec: 1_700_000_000,
        debug: { jupiterRaw: { routePlan: [] } },
      },
      pk(9),
      {
        connection: {} as any,
        whirlpool: pk(10),
        tickSpacing: 1,
        tickCurrentIndex: 0,
        tickArrays: [pk(11), pk(12), pk(13)],
        tokenMintA: pk(14),
        tokenMintB: pk(15),
        tokenVaultA: pk(16),
        tokenVaultB: pk(17),
        tokenProgramA: pk(18),
        tokenProgramB: pk(19),
        aToB: true,
      },
    );

    expect(result.instructions).toHaveLength(1);
    expect(result.lookupTableAddresses).toHaveLength(1);
    expect(vi.mocked(fetchJupiterSwapIxs)).toHaveBeenCalledTimes(1);
  });

  it('throws on router mismatch', async () => {
    const adapter = new JupiterSwapApiAdapter();

    await expect(
      adapter.buildSwapIxs(
        {
          router: 'orca',
          inMint: pk(1).toBase58(),
          outMint: pk(2).toBase58(),
          swapInAmount: 1000n,
          swapMinOutAmount: 900n,
          slippageBpsCap: 50,
          quotedAtUnixSec: 1_700_000_000,
        },
        pk(9),
        {
          connection: {} as any,
          whirlpool: pk(10),
          tickSpacing: 1,
          tickCurrentIndex: 0,
          tickArrays: [pk(11), pk(12), pk(13)],
          tokenMintA: pk(14),
          tokenMintB: pk(15),
          tokenVaultA: pk(16),
          tokenVaultB: pk(17),
          tokenProgramA: pk(18),
          tokenProgramB: pk(19),
          aToB: true,
        },
      ),
    ).rejects.toMatchObject({ code: 'DATA_UNAVAILABLE' });
  });
});
