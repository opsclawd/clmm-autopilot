import { describe, expect, it, vi } from 'vitest';
import { PublicKey, SystemProgram, VersionedTransaction } from '@solana/web3.js';
import { executeOnce } from '../executeOnce';

vi.mock('../orcaInspector', () => ({
  loadPositionSnapshot: vi.fn(async () => ({
    whirlpool: new PublicKey(new Uint8Array(32).fill(1)),
    position: new PublicKey(new Uint8Array(32).fill(2)),
    positionMint: new PublicKey(new Uint8Array(32).fill(3)),
    currentTickIndex: 0,
    lowerTickIndex: 10,
    upperTickIndex: 20,
    tickSpacing: 1,
    inRange: false,
    liquidity: BigInt(1),
    tokenMintA: new PublicKey('So11111111111111111111111111111111111111112'),
    tokenMintB: new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
    tokenDecimalsA: 9,
    tokenDecimalsB: 6,
    tokenVaultA: new PublicKey(new Uint8Array(32).fill(4)),
    tokenVaultB: new PublicKey(new Uint8Array(32).fill(5)),
    tickArrayLower: new PublicKey(new Uint8Array(32).fill(6)),
    tickArrayUpper: new PublicKey(new Uint8Array(32).fill(7)),
    tokenProgramA: new PublicKey(new Uint8Array(32).fill(8)),
    tokenProgramB: new PublicKey(new Uint8Array(32).fill(9)),
    removePreview: null,
    removePreviewReasonCode: 'QUOTE_UNAVAILABLE',
  })),
}));

describe('executeOnce', () => {
  it('returns canonical hold-block error when decision is HOLD', async () => {
    const authority = new PublicKey(new Uint8Array(32).fill(20));
    const connection = {
      getLatestBlockhash: vi.fn(async () => ({ blockhash: 'abc', lastValidBlockHeight: 123 })),
      confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
      simulateTransaction: vi.fn(async () => ({ value: { err: null } })),
      getAccountInfo: vi.fn(async () => null),
      getSlot: vi.fn(async () => 1),
    } as any;

    const res = await executeOnce({
      connection,
      authority,
      position: new PublicKey(new Uint8Array(32).fill(21)),
      samples: [{ slot: 1, unixTs: 1, currentTickIndex: 11 }],
      quote: {
        inputMint: new PublicKey('So11111111111111111111111111111111111111112'),
        outputMint: new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
        slippageBps: 10,
        quotedAtUnixMs: Date.now(),
      },
      slippageBpsCap: 50,
      expectedMinOut: '0',
      quoteAgeMs: 0,
      removeLiquidityIx: SystemProgram.transfer({ fromPubkey: authority, toPubkey: authority, lamports: 0 }),
      collectFeesIx: SystemProgram.transfer({ fromPubkey: authority, toPubkey: authority, lamports: 0 }),
      swapIx: SystemProgram.transfer({ fromPubkey: authority, toPubkey: authority, lamports: 0 }),
      wsolLifecycleIxs: { preSwap: [], postSwap: [] },
      attestationHash: new Uint8Array(32),
      signAndSend: vi.fn(async (_tx: VersionedTransaction) => 'sig'),
    });

    expect(res.errorCode).toBe('DATA_UNAVAILABLE');
    expect(res.ui.canExecute).toBe(false);
  });
});
