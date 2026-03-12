import { describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { computeExecutionRequirements } from '../requirements';
import { getAta } from '../ata';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../token/constants';

const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const USDC_MINT = new PublicKey('BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k');

const pk = (seed: number) => new PublicKey(new Uint8Array(32).fill(seed));

function mockConnection(args: {
  existingAtas: Set<string>;
  mintOwners?: Map<string, PublicKey>;
  tokenAccountRent?: number;
}) {
  return {
    getAccountInfo: vi.fn(async (pubkey: PublicKey) => {
      const key = pubkey.toBase58();
      const mintOwner = args.mintOwners?.get(key);
      if (mintOwner) return { owner: mintOwner, data: Buffer.alloc(82) } as any;
      return args.existingAtas.has(key) ? (({} as unknown) as any) : null;
    }),
    getMinimumBalanceForRentExemption: vi.fn(async () => args.tokenAccountRent ?? 1_000),
  };
}

describe('computeExecutionRequirements', () => {
  it('counts no missing ATAs when all required accounts exist', async () => {
    const authority = pk(1);
    const snapshot = {
      positionMint: pk(111),
      positionTokenProgram: TOKEN_PROGRAM_ID,
      tokenMintA: SOL_MINT,
      tokenMintB: USDC_MINT,
      tokenProgramA: TOKEN_PROGRAM_ID,
      tokenProgramB: TOKEN_PROGRAM_ID,
    };

    const existingAtas = new Set<string>([
      getAta(snapshot.positionMint, authority, snapshot.positionTokenProgram).toBase58(),
      getAta(snapshot.tokenMintA, authority, snapshot.tokenProgramA).toBase58(),
      getAta(snapshot.tokenMintB, authority, snapshot.tokenProgramB).toBase58(),
    ]);

    const res = await computeExecutionRequirements({
      connection: mockConnection({
        existingAtas,
        mintOwners: new Map<string, PublicKey>([
          [snapshot.positionMint.toBase58(), TOKEN_PROGRAM_ID],
          [snapshot.tokenMintA.toBase58(), TOKEN_PROGRAM_ID],
          [snapshot.tokenMintB.toBase58(), TOKEN_PROGRAM_ID],
        ]),
        tokenAccountRent: 2_039_280,
      }),
      snapshot,
      quote: { inputMint: SOL_MINT, outputMint: USDC_MINT },
      swapPlanned: true,
      authority,
      payer: authority,
      txFeeLamports: 20_000,
      computeUnitLimit: 600_000,
      computeUnitPriceMicroLamports: 10_000,
      bufferLamports: 10_000_000,
    });

    expect(res.ataCount).toBe(0);
    expect(res.missingAtas).toEqual([]);
    expect(res.rentLamports).toBe(0);
    expect(res.priorityFeeLamports).toBe(Math.ceil((600_000 * 10_000) / 1_000_000));
    expect(res.totalRequiredLamports).toBe(res.txFeeLamports + res.priorityFeeLamports + res.bufferLamports);
  });

  it('resolves quote mint token programs and emits missingAtas once', async () => {
    const authority = pk(9);
    const positionMint = pk(111);
    const tokenMintA = pk(55);
    const tokenMintB = pk(66);
    const inputMint = pk(33);
    const outputMint = pk(44);
    const snapshot = {
      positionMint,
      positionTokenProgram: TOKEN_PROGRAM_ID,
      tokenMintA,
      tokenMintB,
      tokenProgramA: TOKEN_PROGRAM_ID,
      tokenProgramB: TOKEN_PROGRAM_ID,
    };

    const existingAtas = new Set<string>([getAta(positionMint, authority, TOKEN_PROGRAM_ID).toBase58()]);
    const mintOwners = new Map<string, PublicKey>([
      [positionMint.toBase58(), TOKEN_PROGRAM_ID],
      [tokenMintA.toBase58(), TOKEN_PROGRAM_ID],
      [tokenMintB.toBase58(), TOKEN_PROGRAM_ID],
      [inputMint.toBase58(), TOKEN_2022_PROGRAM_ID],
      [outputMint.toBase58(), TOKEN_PROGRAM_ID],
    ]);

    const res = await computeExecutionRequirements({
      connection: mockConnection({ existingAtas, mintOwners, tokenAccountRent: 1_000 }),
      snapshot,
      quote: { inputMint, outputMint },
      swapPlanned: true,
      authority,
      payer: authority,
      txFeeLamports: 1,
      computeUnitLimit: 1,
      computeUnitPriceMicroLamports: 0,
      bufferLamports: 0,
    });

    expect(res.ataCount).toBe(4);
    expect(res.rentLamports).toBe(4_000);
    expect(res.missingAtas).toHaveLength(4);
    const inputAta = getAta(inputMint, authority, TOKEN_2022_PROGRAM_ID).toBase58();
    expect(res.missingAtas.find((entry) => entry.ata.toBase58() === inputAta)?.tokenProgramId.toBase58()).toBe(
      TOKEN_2022_PROGRAM_ID.toBase58(),
    );
  });

  it('includes WSOL ATA in missingAtas when SOL swap lifecycle is required', async () => {
    const authority = pk(7);
    const snapshot = {
      positionMint: pk(111),
      positionTokenProgram: TOKEN_PROGRAM_ID,
      tokenMintA: SOL_MINT,
      tokenMintB: USDC_MINT,
      tokenProgramA: TOKEN_PROGRAM_ID,
      tokenProgramB: TOKEN_PROGRAM_ID,
    };
    const wsolAta = getAta(SOL_MINT, authority, TOKEN_PROGRAM_ID).toBase58();
    const existingAtas = new Set<string>([
      getAta(snapshot.positionMint, authority, snapshot.positionTokenProgram).toBase58(),
      getAta(snapshot.tokenMintB, authority, snapshot.tokenProgramB).toBase58(),
    ]);

    const res = await computeExecutionRequirements({
      connection: mockConnection({
        existingAtas,
        mintOwners: new Map<string, PublicKey>([
          [snapshot.positionMint.toBase58(), TOKEN_PROGRAM_ID],
          [snapshot.tokenMintA.toBase58(), TOKEN_PROGRAM_ID],
          [snapshot.tokenMintB.toBase58(), TOKEN_PROGRAM_ID],
        ]),
        tokenAccountRent: 500,
      }),
      snapshot,
      quote: { inputMint: USDC_MINT, outputMint: SOL_MINT },
      swapPlanned: true,
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
    expect(res.missingAtas).toHaveLength(1);
    expect(res.missingAtas[0].ata.toBase58()).toBe(wsolAta);
  });
});
