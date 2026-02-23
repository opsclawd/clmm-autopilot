import { describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { computeExecutionRequirements } from '../requirements';
import { getAta } from '../ata';

const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const USDC_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

const pk = (seed: number) => new PublicKey(new Uint8Array(32).fill(seed));

const baseSnapshot = {
  positionMint: pk(111),
  tokenMintA: SOL_MINT,
  tokenMintB: USDC_MINT,
  tokenProgramA: TOKEN_PROGRAM_ID,
  tokenProgramB: TOKEN_PROGRAM_ID,
};

describe('computeExecutionRequirements', () => {
  it('counts no missing ATAs when all exist (including WSOL when SOL involved)', async () => {
    const connection = {
      getAccountInfo: vi.fn(async () => ({}) as any),
      getMinimumBalanceForRentExemption: vi.fn(async () => 2_039_280),
    };

    const res = await computeExecutionRequirements({
      connection,
      snapshot: baseSnapshot,
      quote: { inputMint: SOL_MINT, outputMint: USDC_MINT },
      authority: pk(1),
      payer: pk(1),
      txFeeLamports: 20_000,
      computeUnitLimit: 600_000,
      computeUnitPriceMicroLamports: 10_000,
      bufferLamports: 10_000_000,
    });

    expect(res.ataCount).toBe(0);
    expect(res.rentLamports).toBe(0);
    expect(res.priorityFeeLamports).toBe(Math.ceil((600_000 * 10_000) / 1_000_000));
    expect(res.totalRequiredLamports).toBe(res.txFeeLamports + res.priorityFeeLamports + res.bufferLamports);
  });

  it('counts missing input/output ATAs when swap uses SPL->SPL and both are absent', async () => {
    const missing = new Set<string>();
    const authority = pk(9);

    // Make only the Orca-required *position ATA* exist; anything else missing.
    const existing = new Set<string>([getAta(pk(111), authority, TOKEN_PROGRAM_ID).toBase58()]);

    const connection = {
      getAccountInfo: vi.fn(async (pubkey: PublicKey) => {
        if (missing.has(pubkey.toBase58())) return null;
        // Return null by default for this test unless explicitly marked existing.
        return existing.has(pubkey.toBase58()) ? (({}) as any) : null;
      }),
      getMinimumBalanceForRentExemption: vi.fn(async () => 1000),
    };

    // Force both swap mint ATAs missing by not marking them existing.
    const inputMint = pk(33);
    const outputMint = pk(44);

    const res = await computeExecutionRequirements({
      connection,
      snapshot: { ...baseSnapshot, tokenMintA: inputMint, tokenMintB: outputMint },
      quote: { inputMint, outputMint },
      authority,
      payer: authority,
      txFeeLamports: 1,
      computeUnitLimit: 1,
      computeUnitPriceMicroLamports: 0,
      bufferLamports: 0,
    });

    // Required ATAs: positionMint + tokenMintA + tokenMintB + inputMint + outputMint (some overlap possible).
    // With snapshot tokenMintA/B equal to input/output, the unique set is positionMint + inputMint + outputMint.
    // We marked only positionMint existing => 2 missing.
    expect(res.ataCount).toBe(2);
    expect(res.rentLamports).toBe(2000);
  });

  it('includes WSOL ATA when SOL is output and WSOL ATA is missing', async () => {
    const authority = pk(7);
    const missing = new Set<string>();

    const wsolAta = getAta(SOL_MINT, authority, TOKEN_PROGRAM_ID);
    missing.add(wsolAta.toBase58());

    const connection = {
      getAccountInfo: vi.fn(async (pubkey: PublicKey) => (missing.has(pubkey.toBase58()) ? null : (({}) as any))),
      getMinimumBalanceForRentExemption: vi.fn(async () => 500),
    };

    const res = await computeExecutionRequirements({
      connection,
      snapshot: baseSnapshot,
      quote: { inputMint: USDC_MINT, outputMint: SOL_MINT },
      authority,
      payer: authority,
      txFeeLamports: 0,
      computeUnitLimit: 0,
      computeUnitPriceMicroLamports: 0,
      bufferLamports: 0,
    });

    expect(res.ataCount).toBe(1);
    expect(res.rentLamports).toBe(500);
    expect(res.totalRequiredLamports).toBe(500);
  });
});
