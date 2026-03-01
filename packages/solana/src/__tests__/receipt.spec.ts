import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { buildRecordExecutionIx, deriveReceiptPda } from '../receipt';

describe('receipt helpers', () => {
  const programId = new PublicKey('A81Xsuwg5zrT1sgvkncemfWqQ8nymwHS3e7ExM4YnXMm');

  it('derives deterministic PDA from canonical seeds', () => {
    const authority = new PublicKey('11111111111111111111111111111111');
    const positionMint = new PublicKey('So11111111111111111111111111111111111111112');
    const [a] = deriveReceiptPda({ authority, positionMint, epoch: 1234, programId });
    const [b] = deriveReceiptPda({ authority, positionMint, epoch: 1234, programId });
    expect(a.toBase58()).toBe(b.toBase58());
  });

  it('builds record_execution instruction with program id + accounts', () => {
    const authority = new PublicKey('11111111111111111111111111111111');
    const positionMint = new PublicKey('So11111111111111111111111111111111111111112');
    const attestationHash = new Uint8Array(32);

    const ix = buildRecordExecutionIx({ authority, positionMint, epoch: 42, direction: 0, attestationHash, programId });
    expect(ix.programId.toBase58()).toBe(programId.toBase58());
    expect(ix.keys[0].pubkey.toBase58()).toBe(authority.toBase58());
    expect(ix.keys[0].isSigner).toBe(true);
    expect(ix.data.length).toBe(8 + 4 + 1 + 32 + 32);
    expect(Array.from(ix.data.subarray(0, 8))).toEqual([231, 245, 144, 129, 178, 195, 89, 160]);
  });
});
