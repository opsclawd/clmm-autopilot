import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { buildRecordExecutionIx, deriveReceiptPda, RECEIPT_PROGRAM_ID } from '../receipt';

describe('receipt helpers', () => {
  it('derives deterministic PDA from canonical seeds', () => {
    const authority = new PublicKey('11111111111111111111111111111111');
    const positionMint = new PublicKey('So11111111111111111111111111111111111111112');
    const [a] = deriveReceiptPda({ authority, positionMint, epoch: 1234 });
    const [b] = deriveReceiptPda({ authority, positionMint, epoch: 1234 });
    expect(a.toBase58()).toBe(b.toBase58());
  });

  it('builds record_execution instruction with program id + accounts', () => {
    const authority = new PublicKey('11111111111111111111111111111111');
    const positionMint = new PublicKey('So11111111111111111111111111111111111111112');
    const txSigHash = new Uint8Array(32);

    const ix = buildRecordExecutionIx({ authority, positionMint, epoch: 42, direction: 0, txSigHash });
    expect(ix.programId.toBase58()).toBe(RECEIPT_PROGRAM_ID.toBase58());
    expect(ix.keys[0].pubkey.toBase58()).toBe(authority.toBase58());
    expect(ix.keys[0].isSigner).toBe(true);
    expect(ix.data.length).toBe(8 + 4 + 1 + 32 + 32);
  });
});
