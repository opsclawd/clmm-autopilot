import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { buildOrcaExitIxs } from '../orcaExitBuilder';
import { MEMO_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../token/constants';

const pk = (seed: number) => new PublicKey(new Uint8Array(32).fill(seed));
const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const USDC_MINT = new PublicKey('BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k');

function buildSnapshot(overrides: Partial<Parameters<typeof buildOrcaExitIxs>[0]['snapshot']> = {}) {
  return {
    cluster: 'devnet' as const,
    pairLabel: 'SOL/USDC',
    pairValid: true,
    whirlpool: pk(1),
    position: pk(2),
    positionMint: pk(3),
    positionTokenProgram: TOKEN_PROGRAM_ID,
    currentTickIndex: 100,
    lowerTickIndex: 50,
    upperTickIndex: 150,
    tickSpacing: 1,
    inRange: true,
    liquidity: 10n,
    tokenMintA: SOL_MINT,
    tokenMintB: USDC_MINT,
    tokenDecimalsA: 9,
    tokenDecimalsB: 6,
    tokenVaultA: pk(4),
    tokenVaultB: pk(5),
    tickArrayLower: pk(6),
    tickArrayUpper: pk(7),
    tokenProgramA: TOKEN_PROGRAM_ID,
    tokenProgramB: TOKEN_PROGRAM_ID,
    removePreview: null,
    removePreviewReasonCode: null,
    ...overrides,
  };
}

describe('buildOrcaExitIxs', () => {
  it('uses v1 remove/collect without memo when both sides are token-v1', () => {
    const out = buildOrcaExitIxs({
      snapshot: buildSnapshot(),
      authority: pk(8),
      payer: pk(9),
    });

    expect(out.variant).toBe('v1');
    expect(Array.from(out.removeLiquidityIx.data.subarray(0, 8))).toEqual([160, 38, 208, 111, 104, 91, 44, 1]);
    expect(Array.from(out.collectFeesIx.data.subarray(0, 8))).toEqual([164, 152, 207, 99, 30, 186, 19, 182]);
    expect(out.removeLiquidityIx.keys.some((key) => key.pubkey.equals(MEMO_PROGRAM_ID))).toBe(false);
    expect(out.collectFeesIx.keys.some((key) => key.pubkey.equals(MEMO_PROGRAM_ID))).toBe(false);
  });

  it('uses v2 remove/collect with unconditional memo when token-2022 is involved', () => {
    const out = buildOrcaExitIxs({
      snapshot: buildSnapshot({ tokenProgramB: TOKEN_2022_PROGRAM_ID }),
      authority: pk(8),
      payer: pk(9),
    });

    expect(out.variant).toBe('v2');
    expect(Array.from(out.removeLiquidityIx.data.subarray(0, 8))).toEqual([58, 127, 188, 62, 79, 82, 196, 96]);
    expect(Array.from(out.collectFeesIx.data.subarray(0, 8))).toEqual([207, 117, 95, 191, 229, 180, 226, 15]);
    expect(out.removeLiquidityIx.keys.some((key) => key.pubkey.equals(MEMO_PROGRAM_ID))).toBe(true);
    expect(out.collectFeesIx.keys.some((key) => key.pubkey.equals(MEMO_PROGRAM_ID))).toBe(true);
  });
});
