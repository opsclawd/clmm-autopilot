import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '@clmm-autopilot/core';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { DISABLE_RECEIPT_PROGRAM_FOR_TESTING } from '../receipt';

const DEVNET_USDC_MINT = 'BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k';

const { buildExitTransactionMock, getSwapAdapterMock, buildSwapIxsMock, getQuoteMock } = vi.hoisted(() => ({
  buildExitTransactionMock: vi.fn(async () => ({}) as VersionedTransaction),
  getSwapAdapterMock: vi.fn(),
  buildSwapIxsMock: vi.fn(async () => ({ instructions: [{} as any], lookupTableAddresses: [] as any[] })),
  getQuoteMock: vi.fn(),
}));

vi.mock('../executionBuilder', () => ({
  buildExitTransaction: buildExitTransactionMock,
}));

vi.mock('../swap/registry', () => ({
  getSwapAdapter: getSwapAdapterMock,
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
    tokenMintB: new PublicKey(DEVNET_USDC_MINT),
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
  beforeEach(() => {
    buildExitTransactionMock.mockReset();
    buildExitTransactionMock.mockResolvedValue({} as VersionedTransaction);
    getSwapAdapterMock.mockReset();
    getQuoteMock.mockReset();
    buildSwapIxsMock.mockReset();
    buildSwapIxsMock.mockResolvedValue({ instructions: [{} as any], lookupTableAddresses: [] as any[] });
    getSwapAdapterMock.mockReturnValue({
      getQuote: getQuoteMock,
      buildSwapIxs: buildSwapIxsMock,
    });
  });

  it('loads lookup tables returned by swap adapter into tx builder', async () => {
    buildExitTransactionMock.mockClear();
    const lutAddressA = new PublicKey(new Uint8Array(32).fill(40));
    const lutAddressB = new PublicKey(new Uint8Array(32).fill(41));
    getSwapAdapterMock.mockReturnValue({
      getQuote: getQuoteMock,
      buildSwapIxs: buildSwapIxsMock.mockResolvedValueOnce({
        instructions: [{} as any],
        lookupTableAddresses: [lutAddressA, lutAddressB],
      }),
    });

    const authority = new PublicKey(new Uint8Array(32).fill(20));
    const getAddressLookupTable = vi
      .fn()
      .mockResolvedValueOnce({ value: { key: lutAddressA, state: {} } as any })
      .mockResolvedValueOnce({ value: { key: lutAddressB, state: {} } as any });
    const connection = {
      getLatestBlockhash: vi.fn(async () => ({ blockhash: 'abc', lastValidBlockHeight: 123 })),
      confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
      simulateTransaction: vi.fn(async () => ({ value: { err: null } })),
      getAccountInfo: vi.fn(async () => null),
      getSlot: vi.fn(async () => 1),
      getAddressLookupTable,
      getBalance: vi.fn(async () => 50_000_000),
      getMinimumBalanceForRentExemption: vi.fn(async () => 2_039_280),
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
        outputMint: new PublicKey(DEVNET_USDC_MINT),
        inAmount: BigInt(1),
        outAmount: BigInt(1),
        slippageBps: 10,
        quotedAtUnixMs: Date.now(),
        raw: { inAmount: '1', outAmount: '1' },
      },
      config: { ...DEFAULT_CONFIG, execution: { ...DEFAULT_CONFIG.execution, swapRouter: 'jupiter' } },
      policyState: {},
      expectedMinOut: '0',
      quoteAgeMs: 0,
      attestationHash: new Uint8Array(32),
      attestationPayloadBytes: new Uint8Array(68),
      signAndSend: vi.fn(async (_tx: VersionedTransaction) => 'sig'),
      checkExistingReceipt: async () => false,
    });

    expect(res.status).not.toBe('HOLD');
    expect(getAddressLookupTable).toHaveBeenCalledTimes(2);
    expect(getAddressLookupTable).toHaveBeenNthCalledWith(1, lutAddressA);
    expect(getAddressLookupTable).toHaveBeenNthCalledWith(2, lutAddressB);
    expect(buildExitTransactionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        lookupTableAccounts: [
          expect.objectContaining({ key: lutAddressA }),
          expect.objectContaining({ key: lutAddressB }),
        ],
      }),
    );
  });

  it('skips null lookup table responses and keeps resolved accounts', async () => {
    buildExitTransactionMock.mockClear();
    const lutAddressA = new PublicKey(new Uint8Array(32).fill(42));
    const lutAddressB = new PublicKey(new Uint8Array(32).fill(43));
    getSwapAdapterMock.mockReturnValue({
      getQuote: getQuoteMock,
      buildSwapIxs: buildSwapIxsMock.mockResolvedValueOnce({
        instructions: [{} as any],
        lookupTableAddresses: [lutAddressA, lutAddressB],
      }),
    });

    const authority = new PublicKey(new Uint8Array(32).fill(20));
    const getAddressLookupTable = vi
      .fn()
      .mockResolvedValueOnce({ value: { key: lutAddressA, state: {} } as any })
      .mockResolvedValueOnce({ value: null });
    const connection = {
      getLatestBlockhash: vi.fn(async () => ({ blockhash: 'abc', lastValidBlockHeight: 123 })),
      confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
      simulateTransaction: vi.fn(async () => ({ value: { err: null } })),
      getAccountInfo: vi.fn(async () => null),
      getSlot: vi.fn(async () => 1),
      getAddressLookupTable,
      getBalance: vi.fn(async () => 50_000_000),
      getMinimumBalanceForRentExemption: vi.fn(async () => 2_039_280),
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
        outputMint: new PublicKey(DEVNET_USDC_MINT),
        inAmount: BigInt(1),
        outAmount: BigInt(1),
        slippageBps: 10,
        quotedAtUnixMs: Date.now(),
        raw: { inAmount: '1', outAmount: '1' },
      },
      config: { ...DEFAULT_CONFIG, execution: { ...DEFAULT_CONFIG.execution, swapRouter: 'jupiter' } },
      policyState: {},
      expectedMinOut: '0',
      quoteAgeMs: 0,
      attestationHash: new Uint8Array(32),
      attestationPayloadBytes: new Uint8Array(68),
      signAndSend: vi.fn(async (_tx: VersionedTransaction) => 'sig'),
      checkExistingReceipt: async () => false,
    });

    expect(res.status).not.toBe('HOLD');
    expect(getAddressLookupTable).toHaveBeenCalledTimes(2);
    expect(buildExitTransactionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        lookupTableAccounts: [expect.objectContaining({ key: lutAddressA })],
      }),
    );
  });

  it('preserves supplied jupiter raw payload into planQuote debug for swap build', async () => {
    buildExitTransactionMock.mockClear();
    const authority = new PublicKey(new Uint8Array(32).fill(20));
    const rawQuote = { routePlan: [{ percent: 100 }] };
    const connection = {
      getLatestBlockhash: vi.fn(async () => ({ blockhash: 'abc', lastValidBlockHeight: 123 })),
      confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
      simulateTransaction: vi.fn(async () => ({ value: { err: null } })),
      getAccountInfo: vi.fn(async () => null),
      getSlot: vi.fn(async () => 1),
      getAddressLookupTable: vi.fn(async () => ({ value: null })),
      getBalance: vi.fn(async () => 50_000_000),
      getMinimumBalanceForRentExemption: vi.fn(async () => 2_039_280),
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
        outputMint: new PublicKey(DEVNET_USDC_MINT),
        inAmount: BigInt(1),
        outAmount: BigInt(1),
        slippageBps: 10,
        quotedAtUnixMs: Date.now(),
        raw: rawQuote,
      },
      config: { ...DEFAULT_CONFIG, execution: { ...DEFAULT_CONFIG.execution, swapRouter: 'jupiter' } },
      policyState: {},
      expectedMinOut: '0',
      quoteAgeMs: 0,
      attestationHash: new Uint8Array(32),
      attestationPayloadBytes: new Uint8Array(68),
      signAndSend: vi.fn(async (_tx: VersionedTransaction) => 'sig'),
      checkExistingReceipt: async () => false,
    });

    expect(res.status).not.toBe('HOLD');
    expect(buildSwapIxsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        debug: { jupiterRaw: rawQuote },
      }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('fails fast when supplied jupiter quote is missing raw payload', async () => {
    buildExitTransactionMock.mockClear();
    const authority = new PublicKey(new Uint8Array(32).fill(20));
    const connection = {
      getLatestBlockhash: vi.fn(async () => ({ blockhash: 'abc', lastValidBlockHeight: 123 })),
      confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
      simulateTransaction: vi.fn(async () => ({ value: { err: null } })),
      getAccountInfo: vi.fn(async () => null),
      getSlot: vi.fn(async () => 1),
      getAddressLookupTable: vi.fn(async () => ({ value: null })),
      getBalance: vi.fn(async () => 50_000_000),
      getMinimumBalanceForRentExemption: vi.fn(async () => 2_039_280),
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
        outputMint: new PublicKey(DEVNET_USDC_MINT),
        inAmount: BigInt(1),
        outAmount: BigInt(1),
        slippageBps: 10,
        quotedAtUnixMs: Date.now(),
      },
      config: { ...DEFAULT_CONFIG, execution: { ...DEFAULT_CONFIG.execution, swapRouter: 'jupiter' } },
      policyState: {},
      expectedMinOut: '0',
      quoteAgeMs: 0,
      attestationHash: new Uint8Array(32),
      attestationPayloadBytes: new Uint8Array(68),
      signAndSend: vi.fn(async (_tx: VersionedTransaction) => 'sig'),
      checkExistingReceipt: async () => false,
    });

    expect(res.status).toBe('ERROR');
    expect(res.errorCode).toBe('DATA_UNAVAILABLE');
    expect(buildSwapIxsMock).not.toHaveBeenCalled();
    expect(buildExitTransactionMock).not.toHaveBeenCalled();
  });

  it('preserves supplied orca raw payload into planQuote debug for swap build', async () => {
    buildExitTransactionMock.mockClear();
    const authority = new PublicKey(new Uint8Array(32).fill(20));
    const rawOrcaQuote = {
      amount: '1',
      otherAmountThreshold: '1',
      sqrtPriceLimit: '1',
      amountSpecifiedIsInput: true,
      aToB: true,
      tickArray0: new PublicKey(new Uint8Array(32).fill(30)).toBase58(),
      tickArray1: new PublicKey(new Uint8Array(32).fill(31)).toBase58(),
      tickArray2: new PublicKey(new Uint8Array(32).fill(32)).toBase58(),
      supplementalTickArrays: [],
    };
    const connection = {
      getLatestBlockhash: vi.fn(async () => ({ blockhash: 'abc', lastValidBlockHeight: 123 })),
      confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
      simulateTransaction: vi.fn(async () => ({ value: { err: null } })),
      getAccountInfo: vi.fn(async () => null),
      getSlot: vi.fn(async () => 1),
      getAddressLookupTable: vi.fn(async () => ({ value: null })),
      getBalance: vi.fn(async () => 50_000_000),
      getMinimumBalanceForRentExemption: vi.fn(async () => 2_039_280),
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
        outputMint: new PublicKey(DEVNET_USDC_MINT),
        inAmount: BigInt(1),
        outAmount: BigInt(1),
        slippageBps: 10,
        quotedAtUnixMs: Date.now(),
        raw: rawOrcaQuote,
      },
      config: { ...DEFAULT_CONFIG, execution: { ...DEFAULT_CONFIG.execution, swapRouter: 'orca' } },
      policyState: {},
      expectedMinOut: '0',
      quoteAgeMs: 0,
      attestationHash: new Uint8Array(32),
      attestationPayloadBytes: new Uint8Array(68),
      signAndSend: vi.fn(async (_tx: VersionedTransaction) => 'sig'),
      checkExistingReceipt: async () => false,
    });

    expect(res.status).not.toBe('HOLD');
    expect(buildSwapIxsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        debug: { orcaQuote: rawOrcaQuote },
      }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('fails fast when supplied orca quote is missing raw payload', async () => {
    buildExitTransactionMock.mockClear();
    const authority = new PublicKey(new Uint8Array(32).fill(20));
    const connection = {
      getLatestBlockhash: vi.fn(async () => ({ blockhash: 'abc', lastValidBlockHeight: 123 })),
      confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
      simulateTransaction: vi.fn(async () => ({ value: { err: null } })),
      getAccountInfo: vi.fn(async () => null),
      getSlot: vi.fn(async () => 1),
      getAddressLookupTable: vi.fn(async () => ({ value: null })),
      getBalance: vi.fn(async () => 50_000_000),
      getMinimumBalanceForRentExemption: vi.fn(async () => 2_039_280),
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
        outputMint: new PublicKey(DEVNET_USDC_MINT),
        inAmount: BigInt(1),
        outAmount: BigInt(1),
        slippageBps: 10,
        quotedAtUnixMs: Date.now(),
      },
      config: { ...DEFAULT_CONFIG, execution: { ...DEFAULT_CONFIG.execution, swapRouter: 'orca' } },
      policyState: {},
      expectedMinOut: '0',
      quoteAgeMs: 0,
      attestationHash: new Uint8Array(32),
      attestationPayloadBytes: new Uint8Array(68),
      signAndSend: vi.fn(async (_tx: VersionedTransaction) => 'sig'),
      checkExistingReceipt: async () => false,
    });

    expect(res.status).toBe('ERROR');
    expect(res.errorCode).toBe('DATA_UNAVAILABLE');
    expect(buildSwapIxsMock).not.toHaveBeenCalled();
    expect(buildExitTransactionMock).not.toHaveBeenCalled();
  });

  it('fails fast when swap adapter returns zero instructions for planned swap', async () => {
    buildExitTransactionMock.mockClear();
    buildSwapIxsMock.mockResolvedValueOnce({ instructions: [], lookupTableAddresses: [] });

    const authority = new PublicKey(new Uint8Array(32).fill(20));
    const connection = {
      getLatestBlockhash: vi.fn(async () => ({ blockhash: 'abc', lastValidBlockHeight: 123 })),
      confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
      simulateTransaction: vi.fn(async () => ({ value: { err: null } })),
      getAccountInfo: vi.fn(async () => null),
      getSlot: vi.fn(async () => 1),
      getAddressLookupTable: vi.fn(async () => ({ value: null })),
      getBalance: vi.fn(async () => 50_000_000),
      getMinimumBalanceForRentExemption: vi.fn(async () => 2_039_280),
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
        outputMint: new PublicKey(DEVNET_USDC_MINT),
        inAmount: BigInt(1),
        outAmount: BigInt(1),
        slippageBps: 10,
        quotedAtUnixMs: Date.now(),
        raw: { inAmount: '1', outAmount: '1' },
      },
      config: { ...DEFAULT_CONFIG, execution: { ...DEFAULT_CONFIG.execution, swapRouter: 'jupiter' } },
      policyState: {},
      expectedMinOut: '0',
      quoteAgeMs: 0,
      attestationHash: new Uint8Array(32),
      attestationPayloadBytes: new Uint8Array(68),
      signAndSend: vi.fn(async (_tx: VersionedTransaction) => 'sig'),
      checkExistingReceipt: async () => false,
    });

    expect(res.status).toBe('ERROR');
    expect(res.errorCode).toBe('DATA_UNAVAILABLE');
    expect(buildExitTransactionMock).not.toHaveBeenCalled();
  });

  it('fails fast with unsupported router/cluster even when decision is HOLD', async () => {
    buildExitTransactionMock.mockClear();
    getSwapAdapterMock.mockImplementation(() => {
      throw {
        code: 'SWAP_ROUTER_UNSUPPORTED_CLUSTER',
        retryable: false,
        message: 'swap router does not support cluster',
      };
    });
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
        outputMint: new PublicKey(DEVNET_USDC_MINT),
        inAmount: BigInt(1),
        outAmount: BigInt(1),
        slippageBps: 10,
        quotedAtUnixMs: Date.now(),
        raw: { inAmount: '1', outAmount: '1' },
      },
      config: { ...DEFAULT_CONFIG, execution: { ...DEFAULT_CONFIG.execution, swapRouter: 'jupiter' } },
      policyState: {},
      expectedMinOut: '0',
      quoteAgeMs: 0,
      attestationHash: new Uint8Array(32),
      attestationPayloadBytes: new Uint8Array(68),
      signAndSend: vi.fn(async (_tx: VersionedTransaction) => 'sig'),
    });

    expect(res.status).toBe('ERROR');
    expect(res.errorCode).toBe('SWAP_ROUTER_UNSUPPORTED_CLUSTER');
    expect(buildExitTransactionMock).not.toHaveBeenCalled();
  });

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
        outputMint: new PublicKey(DEVNET_USDC_MINT),
        inAmount: BigInt(1),
        outAmount: BigInt(1),
        slippageBps: 10,
        quotedAtUnixMs: Date.now(),
        raw: { inAmount: '1', outAmount: '1' },
      },
      config: { ...DEFAULT_CONFIG, execution: { ...DEFAULT_CONFIG.execution, swapRouter: "noop" } },
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
        outputMint: new PublicKey(DEVNET_USDC_MINT),
        inAmount: BigInt(1),
        outAmount: BigInt(1),
        slippageBps: 10,
        quotedAtUnixMs: Date.now(),
        raw: { inAmount: '1', outAmount: '1' },
      },
      config: { ...DEFAULT_CONFIG, execution: { ...DEFAULT_CONFIG.execution, swapRouter: "noop" } },
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
        outputMint: new PublicKey(DEVNET_USDC_MINT),
        inAmount: BigInt(1),
        outAmount: BigInt(1),
        slippageBps: 10,
        quotedAtUnixMs: Date.now(),
        raw: { inAmount: '1', outAmount: '1' },
      },
      config: { ...DEFAULT_CONFIG, execution: { ...DEFAULT_CONFIG.execution, swapRouter: "noop" } },
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
          tokenMintB: new PublicKey(DEVNET_USDC_MINT),
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
          outputMint: new PublicKey(DEVNET_USDC_MINT),
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

    if (DISABLE_RECEIPT_PROGRAM_FOR_TESTING) {
      expect(res.errorCode).not.toBe('ALREADY_EXECUTED_THIS_EPOCH');
      return;
    }

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
        outputMint: new PublicKey(DEVNET_USDC_MINT),
        inAmount: BigInt(1),
        outAmount: BigInt(1),
        slippageBps: 10,
        quotedAtUnixMs: Date.now(),
        raw: { inAmount: '1', outAmount: '1' },
      },
      config: { ...DEFAULT_CONFIG, execution: { ...DEFAULT_CONFIG.execution, swapRouter: "noop" } },
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
