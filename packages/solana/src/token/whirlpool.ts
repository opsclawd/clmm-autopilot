import { PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID } from './constants';

export type TokenContext = {
  mintA: PublicKey;
  mintB: PublicKey;
  tokenProgramA: PublicKey;
  tokenProgramB: PublicKey;
  isToken2022A: boolean;
  isToken2022B: boolean;
};

export type WhirlpoolInstructionVariant = 'v1' | 'v2';

export const INCLUDE_MEMO_ON_V2 = true;

export function isToken2022Program(tokenProgramId: PublicKey): boolean {
  return tokenProgramId.equals(TOKEN_2022_PROGRAM_ID);
}

export function buildTokenContext(input: {
  mintA: PublicKey;
  mintB: PublicKey;
  tokenProgramA: PublicKey;
  tokenProgramB: PublicKey;
}): TokenContext {
  return {
    mintA: input.mintA,
    mintB: input.mintB,
    tokenProgramA: input.tokenProgramA,
    tokenProgramB: input.tokenProgramB,
    isToken2022A: isToken2022Program(input.tokenProgramA),
    isToken2022B: isToken2022Program(input.tokenProgramB),
  };
}

export function selectWhirlpoolInstructionVariant(tokenContext: TokenContext): WhirlpoolInstructionVariant {
  return tokenContext.isToken2022A || tokenContext.isToken2022B ? 'v2' : 'v1';
}
