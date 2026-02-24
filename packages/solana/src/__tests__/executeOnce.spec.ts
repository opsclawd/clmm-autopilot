import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '@clmm-autopilot/core';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';

const { buildExitTransactionMock } = vi.hoisted(() => ({
  buildExitTransactionMock: vi.fn(async () => ({}) as VersionedTransaction),
}));

vi.mock('../executionBuilder', () => ({
  buildExitTransaction: buildExitTransactionMock,
}));

vi.mock('../orcaInspector', () => ({
  loadPositionSnapshot: vi.fn(async () => ({
    cluster: 'devnet',
    pairLabel: 'SOL/USDC',
    pairValid: true,
    whirlpool: new PublicKey(new Uint8Array(32).fill(1)),
    position: new PublicKey(new Uint8Array(32).fill(2)),
    positionMint: new PublicKey(new Uint8Array(32).fill(3)),
    currentTickIndex: 15,
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

vi.mock('../receipt', async (importOriginal) => {
  const original = await importOriginal<typeof import('../receipt')>();
  return {
    ...original,
    fetchReceiptByPda: vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ authority: new PublicKey(new Uint8Array(32).fill(1)) } as any),
  };
});

import { executeOnce } from '../executeOnce';
import { loadPositionSnapshot } from '../orcaInspector';

describe('executeOnce', () => {
  it('returns HOLD when decision is HOLD', async () => {
    buildExitTransactionMock.mockClear();
    const authority = new PublicKey(new Uint8Array(32).fill(20));
    const connection = {
      getLatestBlockhash: vi.fn(async () => ({ blockhash: 'abc', lastValidBlockHeight: 123 })),
      confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
      simulateTransaction: vi.fn(async () => ({ value: { err: null } })),
      getAccountInfo: vi.fn(async () => null),
      getSlot: vi.fn(async () => 1),
      getAddressLookupTable: vi.fn(async () => ({ value: null })),
    } as any;

    const res = await executeOnce({
      connection,
      authority,
      position: new PublicKey(new Uint8Array(32).fill(21)),
      samples: [{ slot: 1, unixTs: 1, currentTickIndex: 11 }],
      quote: {
        inputMint: new PublicKey('So11111111111111111111111111111111111111112'),
        outputMint: new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
        inAmount: BigInt(1),
        outAmount: BigInt(1),
        slippageBps: 10,
        quotedAtUnixMs: Date.now(),
        raw: { inAmount: '1', outAmount: '1' },
      },
      config: DEFAULT_CONFIG,
      policyState: {},
      expectedMinOut: '0',
      quoteAgeMs: 0,
      attestationHash: new Uint8Array(32),
      attestationPayloadBytes: new Uint8Array(68),
      signAndSend: vi.fn(async (_tx: VersionedTransaction) => 'sig'),
    });

    expect(res.status).toBe('HOLD');
    expect(res.errorCode).toBeUndefined();
    expect(res.refresh?.decision.decision).toBe('HOLD');
  });

  it('returns mapped simulation diagnostics debug payload on execution failure', async () => {
    buildExitTransactionMock.mockRejectedValueOnce({
      code: 'DATA_UNAVAILABLE',
      retryable: false,
      message: 'Simulation failed due to missing account/ATA',
      debug: { logs: ['could not find account'], err: 'AccountNotFound' },
    });

    const authority = new PublicKey(new Uint8Array(32).fill(20));
    const connection = {
      getLatestBlockhash: vi.fn(async () => ({ blockhash: 'abc', lastValidBlockHeight: 123 })),
      confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
      simulateTransaction: vi.fn(async () => ({ value: { err: null } })),
      getAccountInfo: vi.fn(async () => null),
      getSlot: vi.fn(async () => 1),
      getAddressLookupTable: vi.fn(async () => ({ value: null })),
      getBalance: vi.fn(async () => 50_000_000),
      getMinimumBalanceForRentExemption: vi.fn(async () => 2039280),
    } as any;

    const res = await executeOnce({
      connection,
      authority,
      position: new PublicKey(new Uint8Array(32).fill(21)),
      samples: [
        { slot: 1, unixTs: 1, currentTickIndex: 25 },
        { slot: 2, unixTs: 2, currentTickIndex: 26 },
        { slot: 3, unixTs: 3, currentTickIndex: 27 },
      ],
      quote: {
        inputMint: new PublicKey('So11111111111111111111111111111111111111112'),
        outputMint: new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
        inAmount: BigInt(1),
        outAmount: BigInt(1),
        slippageBps: 10,
        quotedAtUnixMs: Date.now(),
        raw: { inAmount: '1', outAmount: '1' },
      },
      config: DEFAULT_CONFIG,
      policyState: {},
      expectedMinOut: '0',
      quoteAgeMs: 0,
      attestationHash: new Uint8Array(32),
      attestationPayloadBytes: new Uint8Array(68),
      signAndSend: vi.fn(async (_tx: VersionedTransaction) => 'sig'),
      checkExistingReceipt: async () => false,
      buildJupiterSwapIxs: vi.fn(async () => ({ instructions: [], lookupTableAddresses: [] })),
    });

    expect(res.status).toBe('ERROR');
    expect(res.errorCode).toBe('DATA_UNAVAILABLE');
    expect(res.errorDebug).toMatchObject({ logs: ['could not find account'] });
  });

  it('aborts before builder when receipt already exists for canonical epoch', async () => {
    buildExitTransactionMock.mockClear();
    const authority = new PublicKey(new Uint8Array(32).fill(20));
    const connection = {
      getLatestBlockhash: vi.fn(async () => ({ blockhash: 'abc', lastValidBlockHeight: 123 })),
      confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
      simulateTransaction: vi.fn(async () => ({ value: { err: null } })),
      getAccountInfo: vi.fn(async () => null),
      getSlot: vi.fn(async () => 1),
      getAddressLookupTable: vi.fn(async () => ({ value: null })),
    } as any;

    const res = await executeOnce({
      connection,
      authority,
      position: new PublicKey(new Uint8Array(32).fill(21)),
      samples: [
        { slot: 1, unixTs: 1, currentTickIndex: 25 },
        { slot: 2, unixTs: 2, currentTickIndex: 26 },
        { slot: 3, unixTs: 3, currentTickIndex: 27 },
      ],
      quote: {
        inputMint: new PublicKey('So11111111111111111111111111111111111111112'),
        outputMint: new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
        inAmount: BigInt(1),
        outAmount: BigInt(1),
        slippageBps: 10,
        quotedAtUnixMs: Date.now(),
        raw: { inAmount: '1', outAmount: '1' },
      },
      config: DEFAULT_CONFIG,
      policyState: {},
      expectedMinOut: '0',
      quoteAgeMs: 0,
      attestationHash: new Uint8Array(32),
      attestationPayloadBytes: new Uint8Array(68),
      signAndSend: vi.fn(async (_tx: VersionedTransaction) => 'sig'),
      checkExistingReceipt: async () => true,
      rebuildSnapshotAndQuote: async () => ({
        snapshot: {
          cluster: 'devnet',
    pairLabel: 'SOL/USDC',
    pairValid: true,
    whirlpool: new PublicKey(new Uint8Array(32).fill(1)),
          position: new PublicKey(new Uint8Array(32).fill(2)),
          positionMint: new PublicKey(new Uint8Array(32).fill(3)),
          currentTickIndex: 15,
          lowerTickIndex: 10,
          upperTickIndex: 20,
          tickSpacing: 1,
          inRange: true,
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
          removePreviewReasonCode: 'QUOTE_UNAVAILABLE' as const,
        },
        quote: {
          inputMint: new PublicKey('So11111111111111111111111111111111111111112'),
          outputMint: new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
          inAmount: BigInt(1),
          outAmount: BigInt(1),
          slippageBps: 10,
          quotedAtUnixMs: Date.now(),
          raw: { inAmount: '1', outAmount: '1' },
        },
      }),
      sleep: vi.fn(async () => {}),
      nowUnixMs: () => 10_000,
    });

    expect(res.status).toBe('ERROR');
    expect(res.errorCode).toBe('ALREADY_EXECUTED_THIS_EPOCH');
    expect(buildExitTransactionMock).not.toHaveBeenCalled();
  });

  it('returns NOT_SOL_USDC and never reaches tx builder for non-SOL/USDC snapshot', async () => {
    buildExitTransactionMock.mockClear();
    vi.mocked(loadPositionSnapshot).mockRejectedValueOnce({
      code: 'NOT_SOL_USDC',
      retryable: false,
      message: 'Position must be SOL/USDC.',
    });

    const authority = new PublicKey(new Uint8Array(32).fill(20));
    const connection = {
      getLatestBlockhash: vi.fn(async () => ({ blockhash: 'abc', lastValidBlockHeight: 123 })),
      confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
      simulateTransaction: vi.fn(async () => ({ value: { err: null } })),
      getAccountInfo: vi.fn(async () => null),
      getSlot: vi.fn(async () => 1),
      getAddressLookupTable: vi.fn(async () => ({ value: null })),
      getBalance: vi.fn(async () => 50_000_000),
      getMinimumBalanceForRentExemption: vi.fn(async () => 2039280),
    } as any;

    const res = await executeOnce({
      connection,
      authority,
      position: new PublicKey(new Uint8Array(32).fill(21)),
      samples: [
        { slot: 1, unixTs: 1, currentTickIndex: 25 },
        { slot: 2, unixTs: 2, currentTickIndex: 26 },
        { slot: 3, unixTs: 3, currentTickIndex: 27 },
      ],
      quote: {
        inputMint: new PublicKey('So11111111111111111111111111111111111111112'),
        outputMint: new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
        inAmount: BigInt(1),
        outAmount: BigInt(1),
        slippageBps: 10,
        quotedAtUnixMs: Date.now(),
        raw: { inAmount: '1', outAmount: '1' },
      },
      config: DEFAULT_CONFIG,
      policyState: {},
      expectedMinOut: '0',
      quoteAgeMs: 0,
      attestationHash: new Uint8Array(32),
      attestationPayloadBytes: new Uint8Array(68),
      signAndSend: vi.fn(async (_tx: VersionedTransaction) => 'sig'),
      checkExistingReceipt: async () => false,
      buildJupiterSwapIxs: vi.fn(async () => ({ instructions: [], lookupTableAddresses: [] })),
    });

    expect(res.status).toBe('ERROR');
    expect(res.errorCode).toBe('NOT_SOL_USDC');
    expect(buildExitTransactionMock).not.toHaveBeenCalled();
  });
});
