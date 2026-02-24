import { describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';

vi.mock('@clmm-autopilot/core', async () => {
  const SOL = 'So11111111111111111111111111111111111111112';
  const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
  return {
    evaluateRangeBreak: () => ({
      action: 'TRIGGER_DOWN',
      reasonCode: 'BREAK_CONFIRMED',
      debug: { samplesUsed: 3, threshold: 3, cooldownRemainingMs: 0 },
    }),
    unixDaysFromUnixMs: (unixMs: number) => Math.floor(unixMs / 1000 / 86400),
    hashAttestationPayload: (_bytes: Uint8Array) => new Uint8Array(32).fill(1),
    assertSolUsdcPair: (mintA: string, mintB: string) => {
      if (!((mintA === SOL && mintB === USDC) || (mintA === USDC && mintB === SOL))) {
        const err = new Error('Unsupported pair') as Error & { code: 'NOT_SOL_USDC'; retryable: false };
        err.code = 'NOT_SOL_USDC';
        err.retryable = false;
        throw err;
      }
    },
  };
});

vi.mock('../orcaInspector', async () => {
  const { PublicKey } = await import('@solana/web3.js');
  const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
  const USDC_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
  return {
    loadPositionSnapshot: async () => ({
      cluster: 'devnet',
      pairLabel: 'SOL/USDC',
      pairValid: true,
      whirlpool: new PublicKey(new Uint8Array(32).fill(10)),
      position: new PublicKey(new Uint8Array(32).fill(11)),
      positionMint: new PublicKey(new Uint8Array(32).fill(12)),
      currentTickIndex: 100,
      lowerTickIndex: 50,
      upperTickIndex: 150,
      tickSpacing: 1,
      inRange: true,
      liquidity: BigInt(10),
      tokenMintA: SOL_MINT,
      tokenMintB: USDC_MINT,
      tokenDecimalsA: 9,
      tokenDecimalsB: 6,
      tokenVaultA: new PublicKey(new Uint8Array(32).fill(13)),
      tokenVaultB: new PublicKey(new Uint8Array(32).fill(14)),
      tickArrayLower: new PublicKey(new Uint8Array(32).fill(15)),
      tickArrayUpper: new PublicKey(new Uint8Array(32).fill(16)),
      tokenProgramA: new PublicKey(new Uint8Array(32).fill(17)),
      tokenProgramB: new PublicKey(new Uint8Array(32).fill(18)),
      removePreview: { tokenAOut: BigInt(1), tokenBOut: BigInt(1) },
      removePreviewReasonCode: null,
    }),
  };
});

describe('executeOnce underfunded', () => {
  it('returns canonical error and preserves debug payload end-to-end', async () => {
    const authority = new PublicKey(new Uint8Array(32).fill(1));
    const position = new PublicKey(new Uint8Array(32).fill(2));

    const connection: any = {
      getSlot: vi.fn(async () => 0),
      getBalance: vi.fn(async () => 1),
      getLatestBlockhash: vi.fn(async () => ({ blockhash: 'EETubP5AKH2uP8WqzU7xYfPqBrM6oTnP3v8igJE6wz7A', lastValidBlockHeight: 1 })),
      getAccountInfo: vi.fn(async () => null),
      getMinimumBalanceForRentExemption: vi.fn(async () => 2_039_280),
      simulateTransaction: vi.fn(async () => ({ value: { err: null } })),
      getAddressLookupTable: vi.fn(async () => ({ value: null })),
    };

    const quote = {
      inputMint: new PublicKey('So11111111111111111111111111111111111111112'),
      outputMint: new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
      inAmount: BigInt(1),
      outAmount: BigInt(1),
      slippageBps: 1,
      quotedAtUnixMs: 1,
      raw: { inAmount: '1', outAmount: '1' },
    };

    const { executeOnce } = await import('../executeOnce');

    const res = await executeOnce({
      connection,
      authority,
      position,
      samples: [{ unixMs: 0, currentTickIndex: 0, lowerTickIndex: 0, upperTickIndex: 0 } as any],
      quote: quote as any,
      slippageBpsCap: 50,
      expectedMinOut: '0',
      quoteAgeMs: 0,
      attestationHash: new Uint8Array(32).fill(1),
      attestationPayloadBytes: (() => {
        const b = new Uint8Array(217);
        b.set(authority.toBuffer(), 0);
        b.set(new PublicKey(new Uint8Array(32).fill(12)).toBuffer(), 32);
        // lower=50 i32 LE
        b[69] = 50;
        // upper=150 i32 LE
        b[73] = 150;
        // current=100 i32 LE
        b[77] = 100;
        b.set(new PublicKey('So11111111111111111111111111111111111111112').toBuffer(), 97);
        b.set(new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU').toBuffer(), 129);
        b[161] = 1; // quoteInAmount
        b[169] = 1; // quoteOutAmount
        b[177] = 1; // quoteSlippageBps
        b[181] = 1; // quoteQuotedAtUnixMs
        b[189] = 0xC0; b[190] = 0x27; b[191] = 0x09; // 600000 LE u32
        b[193] = 0x10; b[194] = 0x27; // 10000 LE u64 low bytes
        b[201] = 50; // maxSlippageBps
        b[205] = 0x20; b[206] = 0x4E; // 20000 LE u64 low bytes
        b[213] = 3; // maxRebuildAttempts
        return b;
      })(),
      buildJupiterSwapIxs: vi.fn(async () => ({ instructions: [], lookupTableAddresses: [] })),
      signAndSend: vi.fn(async () => 'sig'),
      nowUnixMs: () => 0,
    });

    expect(res.status).toBe('ERROR');
    expect(res.errorCode).toBe('INSUFFICIENT_FEE_BUFFER');
    expect(res.errorDebug).toMatchObject({
      availableLamports: 1,
      requirements: { ataCount: expect.any(Number), totalRequiredLamports: expect.any(Number) },
      deficitLamports: expect.any(Number),
    });
  });
});
