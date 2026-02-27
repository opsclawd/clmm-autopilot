import { describe, expect, it, vi } from 'vitest';
import BN from 'bn.js';
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';

vi.mock('@orca-so/whirlpools-sdk', () => ({
  UseFallbackTickArray: { Never: 'Never' },
  WhirlpoolContext: {
    from: vi.fn((_connection: unknown, _wallet: unknown) => ({
      program: {},
      fetcher: {},
    })),
  },
  buildWhirlpoolClient: vi.fn(() => ({
    getPool: vi.fn(async (_pool: PublicKey) => ({})),
  })),
  swapQuoteByInputToken: vi.fn(async () => ({
    amount: new BN('1000'),
    otherAmountThreshold: new BN('900'),
    sqrtPriceLimit: new BN('1'),
    amountSpecifiedIsInput: true,
    aToB: true,
    tickArray0: new PublicKey(new Uint8Array(32).fill(21)),
    tickArray1: new PublicKey(new Uint8Array(32).fill(22)),
    tickArray2: new PublicKey(new Uint8Array(32).fill(23)),
    supplementalTickArrays: [],
  })),
  WhirlpoolIx: {
    swapV2Ix: vi.fn(() => ({
      instructions: [{ programId: new PublicKey(new Uint8Array(32).fill(30)) } as unknown as TransactionInstruction],
      cleanupInstructions: [],
      signers: [],
    })),
  },
  PDAUtil: {
    getOracle: vi.fn(() => ({ publicKey: new PublicKey(new Uint8Array(32).fill(77)) })),
  },
}));

import { OrcaWhirlpoolSwapAdapter } from '../swap/orca/OrcaWhirlpoolSwapAdapter';

const pk = (n: number) => new PublicKey(new Uint8Array(32).fill(n));

describe('OrcaWhirlpoolSwapAdapter', () => {
  it('builds SDK quote and returns canonical swap quote shape', async () => {
    const adapter = new OrcaWhirlpoolSwapAdapter();
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
        tickArrays: [pk(21), pk(22), pk(23)],
        tokenMintA: pk(4),
        tokenMintB: pk(5),
        tokenVaultA: pk(6),
        tokenVaultB: pk(7),
        tokenProgramA: pk(8),
        tokenProgramB: pk(9),
        aToB: true,
      },
    });

    expect(quote.router).toBe('orca');
    expect(quote.swapInAmount).toBe(1000n);
    expect(quote.swapMinOutAmount).toBe(900n);
    expect(quote.debug?.orcaQuote).toBeDefined();
  });

  it('builds swap instruction from quote debug metadata', async () => {
    const adapter = new OrcaWhirlpoolSwapAdapter();
    const quote = {
      router: 'orca' as const,
      inMint: pk(1).toBase58(),
      outMint: pk(2).toBase58(),
      swapInAmount: 1000n,
      swapMinOutAmount: 900n,
      slippageBpsCap: 50,
      quotedAtUnixSec: 1700000000,
      debug: {
        orcaQuote: {
          amount: '1000',
          otherAmountThreshold: '900',
          sqrtPriceLimit: '1',
          amountSpecifiedIsInput: true,
          aToB: true,
          tickArray0: pk(21).toBase58(),
          tickArray1: pk(22).toBase58(),
          tickArray2: pk(23).toBase58(),
          supplementalTickArrays: [],
        },
      },
    };

    const ixs = await adapter.buildSwapIxs(quote, pk(10), {
      connection: {} as any,
      whirlpool: pk(3),
      tickSpacing: 1,
      tickCurrentIndex: 0,
      tickArrays: [pk(21), pk(22), pk(23)],
      tokenMintA: pk(4),
      tokenMintB: pk(5),
      tokenVaultA: pk(6),
      tokenVaultB: pk(7),
      tokenProgramA: pk(8),
      tokenProgramB: pk(9),
      aToB: true,
    });

    expect(ixs.length).toBeGreaterThan(0);
  });
});
