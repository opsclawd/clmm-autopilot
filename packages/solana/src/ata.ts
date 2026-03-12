import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { ASSOCIATED_TOKEN_PROGRAM_ID } from './token/constants';

export const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

export type AtaPlanEntry = {
  ata: PublicKey;
  mint: PublicKey;
  owner: PublicKey;
  tokenProgramId: PublicKey;
};

export function getAta(mint: PublicKey, owner: PublicKey, tokenProgramId: PublicKey): PublicKey {
  // allowOwnerOffCurve=true so deterministic tests and PDA-like owners do not throw.
  return getAssociatedTokenAddressSync(mint, owner, true, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);
}

export function createAtaIxFromPlan(planEntry: AtaPlanEntry, payer: PublicKey): TransactionInstruction {
  return createAssociatedTokenAccountIdempotentInstruction(
    payer,
    planEntry.ata,
    planEntry.owner,
    planEntry.mint,
    planEntry.tokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}
