import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

export const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

export function getAta(mint: PublicKey, owner: PublicKey, tokenProgramId: PublicKey = TOKEN_PROGRAM_ID): PublicKey {
  // allowOwnerOffCurve=true so deterministic tests and PDA-like owners do not throw.
  return getAssociatedTokenAddressSync(mint, owner, true, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);
}

export function buildCreateAtaIdempotentIx(params: {
  payer: PublicKey;
  owner: PublicKey;
  mint: PublicKey;
  tokenProgramId?: PublicKey;
}): { ata: PublicKey; ix: TransactionInstruction } {
  const tokenProgramId = params.tokenProgramId ?? TOKEN_PROGRAM_ID;
  const ata = getAta(params.mint, params.owner, tokenProgramId);
  return {
    ata,
    ix: createAssociatedTokenAccountIdempotentInstruction(
      params.payer,
      ata,
      params.owner,
      params.mint,
      tokenProgramId,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
  };
}
