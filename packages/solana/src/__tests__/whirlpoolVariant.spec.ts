import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { buildTokenContext, selectWhirlpoolInstructionVariant } from '../token/whirlpool';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../token/constants';

const pk = (seed: number) => new PublicKey(new Uint8Array(32).fill(seed));

describe('selectWhirlpoolInstructionVariant', () => {
  it('chooses v1 for token/token', () => {
    const variant = selectWhirlpoolInstructionVariant(
      buildTokenContext({
        mintA: pk(1),
        mintB: pk(2),
        tokenProgramA: TOKEN_PROGRAM_ID,
        tokenProgramB: TOKEN_PROGRAM_ID,
      }),
    );
    expect(variant).toBe('v1');
  });

  it('chooses v2 for token2022/token', () => {
    const variant = selectWhirlpoolInstructionVariant(
      buildTokenContext({
        mintA: pk(1),
        mintB: pk(2),
        tokenProgramA: TOKEN_2022_PROGRAM_ID,
        tokenProgramB: TOKEN_PROGRAM_ID,
      }),
    );
    expect(variant).toBe('v2');
  });

  it('chooses v2 for token/token2022', () => {
    const variant = selectWhirlpoolInstructionVariant(
      buildTokenContext({
        mintA: pk(1),
        mintB: pk(2),
        tokenProgramA: TOKEN_PROGRAM_ID,
        tokenProgramB: TOKEN_2022_PROGRAM_ID,
      }),
    );
    expect(variant).toBe('v2');
  });

  it('chooses v2 for token2022/token2022', () => {
    const variant = selectWhirlpoolInstructionVariant(
      buildTokenContext({
        mintA: pk(1),
        mintB: pk(2),
        tokenProgramA: TOKEN_2022_PROGRAM_ID,
        tokenProgramB: TOKEN_2022_PROGRAM_ID,
      }),
    );
    expect(variant).toBe('v2');
  });
});
