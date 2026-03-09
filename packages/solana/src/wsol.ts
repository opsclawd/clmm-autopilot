import { PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js';
import { createCloseAccountInstruction, createSyncNativeInstruction } from '@solana/spl-token';
import { getAta, SOL_MINT } from './ata';
import { TOKEN_PROGRAM_ID } from './token/constants';

export type WsolLifecycle = {
  preSwap: TransactionInstruction[];
  postSwap: TransactionInstruction[];
  wsolAta: PublicKey;
};

export function buildWsolLifecycleIxs(params: {
  authority: PublicKey;
  payer: PublicKey;
  inputMint: PublicKey;
  outputMint: PublicKey;
  // When input is SOL, this is the lamports amount that must be wrapped into WSOL before swap.
  wrapLamports?: bigint;
}): WsolLifecycle {
  const involvesSol = params.inputMint.equals(SOL_MINT) || params.outputMint.equals(SOL_MINT);
  const wsolAta = getAta(SOL_MINT, params.authority, TOKEN_PROGRAM_ID);

  if (!involvesSol) {
    return { preSwap: [], postSwap: [], wsolAta };
  }

  const preSwap: TransactionInstruction[] = [];
  const postSwap: TransactionInstruction[] = [];

  if (params.inputMint.equals(SOL_MINT)) {
    if (params.wrapLamports === undefined) {
      throw new Error('wrapLamports is required when inputMint is SOL');
    }

    preSwap.push(
      SystemProgram.transfer({
        fromPubkey: params.authority,
        toPubkey: wsolAta,
        lamports: Number(params.wrapLamports),
      }),
    );
    preSwap.push(createSyncNativeInstruction(wsolAta, TOKEN_PROGRAM_ID));
  }

  // Always close WSOL ATA when SOL was involved in swap. This unwraps any residual
  // WSOL (including collected fees/dust) back to native SOL and avoids stranded WSOL.
  postSwap.push(createCloseAccountInstruction(wsolAta, params.authority, params.authority, [], TOKEN_PROGRAM_ID));

  return { preSwap, postSwap, wsolAta };
}
