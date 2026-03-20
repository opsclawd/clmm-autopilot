import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '@clmm-autopilot/core';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { deriveReceiptPda, fetchReceiptByPda } from '../receipt';
import { TOKEN_PROGRAM_ID } from '../token/constants';
import { createSqliteLocalReceiptLedger } from '../localReceiptLedger';

const DEVNET_USDC_MINT = 'BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k';
const RECEIPT_PROGRAM_ID = new PublicKey(DEFAULT_CONFIG.receiptProgramId!);
const BPF_UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

function getAccountInfoForProgramOnly(programId = RECEIPT_PROGRAM_ID) {
  return vi.fn(async (pubkey: PublicKey) => {
    if (pubkey.equals(programId)) {
      return {
        executable: true,
        owner: BPF_UPGRADEABLE_LOADER,
        lamports: 1,
        data: Buffer.alloc(0),
        rentEpoch: 0,
      };
    }
    // Requirements/token-program resolution path probes arbitrary mints + ATA addresses.
    // Return a generic token-owned account by default so tests can focus on executeOnce behavior.
    return {
      executable: false,
      owner: TOKEN_PROGRAM_ID,
      lamports: 1,
      data: Buffer.alloc(82),
      rentEpoch: 0,
    };
  });
}

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
    fetchReceiptByPda: vi.fn(),
  };
});

import { executeOnce } from '../executeOnce';
import { loadPositionSnapshot } from '../orcaInspector';
import { createRuntimeCounterRegistry } from '../telemetry';

const EXECUTE_CONFIG = {
  ...DEFAULT_CONFIG,
  execution: {
    ...DEFAULT_CONFIG.execution,
    localReceiptDbPath: ':memory:',
  },
  operator: {
    ...DEFAULT_CONFIG.operator,
    runtimeMode: 'execute' as const,
  },
};

function makeReceiptAccount(overrides: Record<string, unknown> = {}) {
  return {
    authority: new PublicKey(new Uint8Array(32).fill(1)),
    positionMint: new PublicKey(new Uint8Array(32).fill(3)),
    epoch: 0,
    direction: 0,
    attestationHash: new Uint8Array(32).fill(7),
    slot: 1n,
    unixTs: 1n,
    initialized: true,
    bump: 255,
    ...overrides,
  } as any;
}

describe('executeOnce', () => {
  beforeEach(() => {
    vi.mocked(loadPositionSnapshot).mockReset();
    vi.mocked(loadPositionSnapshot).mockResolvedValue({
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
    } as any);
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
    vi.mocked(fetchReceiptByPda).mockReset();
    vi.mocked(fetchReceiptByPda).mockResolvedValue(makeReceiptAccount());
  });

  it('blocks dry-run mode before build even when called directly', async () => {
    const authority = new PublicKey(new Uint8Array(32).fill(20));
    const buildCountsBefore = buildExitTransactionMock.mock.calls.length;
    const signAndSend = vi.fn(async () => 'sig');
    const connection = {
      getLatestBlockhash: vi.fn(async () => ({ blockhash: 'abc', lastValidBlockHeight: 123 })),
      confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
      simulateTransaction: vi.fn(async () => ({ value: { err: null } })),
      getAccountInfo: getAccountInfoForProgramOnly(),
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
      config: { ...DEFAULT_CONFIG, operator: { ...DEFAULT_CONFIG.operator, runtimeMode: 'dry-run' } },
      policyState: {},
      expectedMinOut: '0',
      quoteAgeMs: 0,
      signAndSend,
    });

    expect(res.status).toBe('ERROR');
    expect(res.errorCode).toBe('EXECUTION_MODE_BLOCKED');
    expect(signAndSend).not.toHaveBeenCalled();
    expect(buildExitTransactionMock.mock.calls.length).toBe(buildCountsBefore);
  });

  it('blocks paused execute mode at the runtime boundary', async () => {
    const authority = new PublicKey(new Uint8Array(32).fill(20));
    const signAndSend = vi.fn(async () => 'sig');
    const connection = {
      getLatestBlockhash: vi.fn(async () => ({ blockhash: 'abc', lastValidBlockHeight: 123 })),
      confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
      simulateTransaction: vi.fn(async () => ({ value: { err: null } })),
      getAccountInfo: getAccountInfoForProgramOnly(),
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
        { slot: 1, unixTs: 1, currentTickIndex: 15 },
        { slot: 2, unixTs: 2, currentTickIndex: 15 },
        { slot: 3, unixTs: 3, currentTickIndex: 15 },
      ],
      config: EXECUTE_CONFIG,
      policyState: {},
      expectedMinOut: '0',
      quoteAgeMs: 0,
      signAndSend,
      runtimeEnvironment: {
        executionPausedOverride: true,
      },
    });

    expect(res.status).toBe('ERROR');
    expect(res.errorCode).toBe('EXECUTION_PAUSED');
    expect(signAndSend).not.toHaveBeenCalled();
  });

  it('simulate-only mode builds and simulates without sending', async () => {
    vi.mocked(fetchReceiptByPda).mockResolvedValue(null);
    const authority = new PublicKey(new Uint8Array(32).fill(20));
    const signAndSend = vi.fn(async () => 'sig');
    const confirmTransaction = vi.fn(async () => ({ value: { err: null } }));
    const connection = {
      getLatestBlockhash: vi.fn(async () => ({ blockhash: 'abc', lastValidBlockHeight: 123 })),
      confirmTransaction,
      simulateTransaction: vi.fn(async () => ({ value: { err: null } })),
      getAccountInfo: getAccountInfoForProgramOnly(),
      getSlot: vi.fn(async () => 1),
      getAddressLookupTable: vi.fn(async () => ({ value: null })),
      getBalance: vi.fn(async () => 50_000_000),
      getMinimumBalanceForRentExemption: vi.fn(async () => 2_039_280),
    } as any;

    const result = await executeOnce({
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
      signAndSend,
      runtimeEnvironment: {
        walletConnected: false,
        signingAvailable: false,
      },
    });

    expect(result.status).toBe('SIMULATED');
    expect(result.execution?.unsignedTxBuilt).toBe(true);
    expect(result.execution?.simulated).toBe(true);
    expect(signAndSend).not.toHaveBeenCalled();
    expect(confirmTransaction).not.toHaveBeenCalled();
  });

  it('emits canonical event fields and deterministic counters', async () => {
    vi.mocked(fetchReceiptByPda).mockResolvedValue(null);
    const authority = new PublicKey(new Uint8Array(32).fill(20));
    const counters = createRuntimeCounterRegistry();
    const observer = { emit: vi.fn() };
    const connection = {
      getLatestBlockhash: vi.fn(async () => ({ blockhash: 'abc', lastValidBlockHeight: 123 })),
      confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
      simulateTransaction: vi.fn(async () => ({ value: { err: null } })),
      getAccountInfo: getAccountInfoForProgramOnly(),
      getSlot: vi.fn(async () => 1),
      getAddressLookupTable: vi.fn(async () => ({ value: null })),
      getBalance: vi.fn(async () => 50_000_000),
      getMinimumBalanceForRentExemption: vi.fn(async () => 2_039_280),
    } as any;

    await executeOnce({
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
      signAndSend: vi.fn(async () => 'sig'),
      observer,
      counters,
    });

    expect(observer.emit).toHaveBeenCalled();
    expect(observer.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.any(String),
        timestamp: expect.any(String),
        cluster: 'devnet',
        runtimeMode: 'simulate-only',
        executionPaused: false,
        authority: authority.toBase58(),
        position: expect.any(String),
        correlationId: expect.any(String),
        status: expect.any(String),
      }),
    );
    expect(counters.snapshot().snapshotsFetched).toBeGreaterThan(0);
    expect(counters.snapshot().buildAttempts).toBeGreaterThan(0);
    expect(createRuntimeCounterRegistry().snapshot().buildAttempts).toBe(0);

    const emittedEvents = observer.emit.mock.calls.map((args) => args[0] as { event: string; status: string });
    const triggerEvent = emittedEvents.find((event) => event.event.startsWith('policy.decision_trigger'));
    expect(triggerEvent?.status).toBe('hypothetical');
  });

  it('mainnet-shadow omits receipt ix when on-chain receipts are disabled', async () => {
    const authority = new PublicKey(new Uint8Array(32).fill(20));
    const connection = {
      getLatestBlockhash: vi.fn(async () => ({ blockhash: 'abc', lastValidBlockHeight: 123 })),
      confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
      simulateTransaction: vi.fn(async () => ({ value: { err: null } })),
      getAccountInfo: getAccountInfoForProgramOnly(),
      getParsedAccountInfo: vi.fn(async () => ({
        context: { slot: 1 },
        value: {
          data: {
            program: 'bpf-upgradeable-loader',
            parsed: { info: { programData: new PublicKey(new Uint8Array(32).fill(31)).toBase58() } },
          },
        },
      })),
      getSlot: vi.fn(async () => 1),
      getAddressLookupTable: vi.fn(async () => ({ value: null })),
      getBalance: vi.fn(async () => 50_000_000),
      getMinimumBalanceForRentExemption: vi.fn(async () => 2_039_280),
    } as any;

    const result = await executeOnce({
      connection,
      authority,
      position: new PublicKey(new Uint8Array(32).fill(21)),
      samples: [
        { slot: 1, unixTs: 1, currentTickIndex: 25 },
        { slot: 2, unixTs: 2, currentTickIndex: 26 },
        { slot: 3, unixTs: 3, currentTickIndex: 27 },
      ],
      config: {
        ...DEFAULT_CONFIG,
        cluster: 'mainnet',
        executionMode: 'mainnet-shadow',
        execution: {
          ...DEFAULT_CONFIG.execution,
          onChainReceiptEnabled: false,
          swapRouter: 'noop',
          sendEnabled: false,
          allowMainnetNoopForDiagnostics: true,
        },
        operator: {
          ...DEFAULT_CONFIG.operator,
          executionMode: 'mainnet-shadow',
          runtimeMode: 'simulate-only',
        },
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
      policyState: {},
      expectedMinOut: '0',
      quoteAgeMs: 0,
      runtimeEnvironment: {
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        walletConnected: false,
        signingAvailable: false,
      },
      checkExistingReceipt: async () => false,
    });

    expect(result.status).toBe('SIMULATED');
    expect(result.shadow?.receiptIxIncluded).toBe(false);
    expect(result.shadow?.receiptPdaExpected).toBeUndefined();
    expect(result.metadata?.executionIntent.receiptIxIncluded).toBe(false);
    expect(buildExitTransactionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        receiptProgramId: undefined,
      }),
    );
  });

  it('mainnet-shadow preserves BUILD_OK when simulation fails after tx build', async () => {
    const authority = new PublicKey(new Uint8Array(32).fill(20));
    buildExitTransactionMock.mockRejectedValueOnce({
      code: 'SIMULATION_FAILED',
      retryable: false,
      message: 'Simulation failed',
      debug: { txBuilt: true, logs: ['sim failed'] },
    });
    const connection = {
      getLatestBlockhash: vi.fn(async () => ({ blockhash: 'abc', lastValidBlockHeight: 123 })),
      confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
      simulateTransaction: vi.fn(async () => ({ value: { err: null } })),
      getAccountInfo: getAccountInfoForProgramOnly(),
      getParsedAccountInfo: vi.fn(async () => ({
        context: { slot: 1 },
        value: {
          data: {
            program: 'bpf-upgradeable-loader',
            parsed: { info: { programData: new PublicKey(new Uint8Array(32).fill(31)).toBase58() } },
          },
        },
      })),
      getSlot: vi.fn(async () => 1),
      getAddressLookupTable: vi.fn(async () => ({ value: null })),
      getBalance: vi.fn(async () => 50_000_000),
      getMinimumBalanceForRentExemption: vi.fn(async () => 2_039_280),
    } as any;

    const result = await executeOnce({
      connection,
      authority,
      position: new PublicKey(new Uint8Array(32).fill(21)),
      samples: [
        { slot: 1, unixTs: 1, currentTickIndex: 25 },
        { slot: 2, unixTs: 2, currentTickIndex: 26 },
        { slot: 3, unixTs: 3, currentTickIndex: 27 },
      ],
      config: {
        ...DEFAULT_CONFIG,
        cluster: 'mainnet',
        executionMode: 'mainnet-shadow',
        execution: {
          ...DEFAULT_CONFIG.execution,
          onChainReceiptEnabled: false,
          swapRouter: 'noop',
          sendEnabled: false,
          allowMainnetNoopForDiagnostics: true,
        },
        operator: {
          ...DEFAULT_CONFIG.operator,
          executionMode: 'mainnet-shadow',
          runtimeMode: 'simulate-only',
        },
        receiptProgramId: DEFAULT_CONFIG.receiptProgramId,
        receiptIdlHashMode: DEFAULT_CONFIG.receiptIdlHashMode,
        receiptIdlHash: DEFAULT_CONFIG.receiptIdlHash,
        receiptIdlPath: DEFAULT_CONFIG.receiptIdlPath,
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
      policyState: {},
      expectedMinOut: '0',
      quoteAgeMs: 0,
      runtimeEnvironment: {
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        walletConnected: false,
        signingAvailable: false,
      },
      checkExistingReceipt: async () => false,
    });

    expect(result.status).toBe('ERROR');
    expect(result.errorCode).toBe('SIMULATION_FAILED');
    expect(result.shadow?.txBuildStatus).toBe('BUILD_OK');
  });

  it('mainnet-shadow preserves BUILD_FAILED when tx build aborts before simulation', async () => {
    const authority = new PublicKey(new Uint8Array(32).fill(20));
    buildExitTransactionMock.mockRejectedValueOnce({
      code: 'DATA_UNAVAILABLE',
      retryable: false,
      message: 'missing route',
    });
    const connection = {
      getLatestBlockhash: vi.fn(async () => ({ blockhash: 'abc', lastValidBlockHeight: 123 })),
      confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
      simulateTransaction: vi.fn(async () => ({ value: { err: null } })),
      getAccountInfo: getAccountInfoForProgramOnly(),
      getParsedAccountInfo: vi.fn(async () => ({
        context: { slot: 1 },
        value: {
          data: {
            program: 'bpf-upgradeable-loader',
            parsed: { info: { programData: new PublicKey(new Uint8Array(32).fill(31)).toBase58() } },
          },
        },
      })),
      getSlot: vi.fn(async () => 1),
      getAddressLookupTable: vi.fn(async () => ({ value: null })),
      getBalance: vi.fn(async () => 50_000_000),
      getMinimumBalanceForRentExemption: vi.fn(async () => 2_039_280),
    } as any;

    const result = await executeOnce({
      connection,
      authority,
      position: new PublicKey(new Uint8Array(32).fill(21)),
      samples: [
        { slot: 1, unixTs: 1, currentTickIndex: 25 },
        { slot: 2, unixTs: 2, currentTickIndex: 26 },
        { slot: 3, unixTs: 3, currentTickIndex: 27 },
      ],
      config: {
        ...DEFAULT_CONFIG,
        cluster: 'mainnet',
        executionMode: 'mainnet-shadow',
        execution: {
          ...DEFAULT_CONFIG.execution,
          onChainReceiptEnabled: false,
          swapRouter: 'noop',
          sendEnabled: false,
          allowMainnetNoopForDiagnostics: true,
        },
        operator: {
          ...DEFAULT_CONFIG.operator,
          executionMode: 'mainnet-shadow',
          runtimeMode: 'simulate-only',
        },
        receiptProgramId: DEFAULT_CONFIG.receiptProgramId,
        receiptIdlHashMode: DEFAULT_CONFIG.receiptIdlHashMode,
        receiptIdlHash: DEFAULT_CONFIG.receiptIdlHash,
        receiptIdlPath: DEFAULT_CONFIG.receiptIdlPath,
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
      policyState: {},
      expectedMinOut: '0',
      quoteAgeMs: 0,
      runtimeEnvironment: {
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        walletConnected: false,
        signingAvailable: false,
      },
      checkExistingReceipt: async () => false,
    });

    expect(result.status).toBe('ERROR');
    expect(result.errorCode).toBe('DATA_UNAVAILABLE');
    expect(result.shadow?.txBuildStatus).toBe('BUILD_FAILED');
  });

  it('marks policy trigger events as ok in execute mode', async () => {
    const authority = new PublicKey(new Uint8Array(32).fill(20));
    const observer = { emit: vi.fn() };
    const connection = {
      getLatestBlockhash: vi.fn(async () => ({ blockhash: 'abc', lastValidBlockHeight: 123 })),
      confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
      simulateTransaction: vi.fn(async () => ({ value: { err: null } })),
      getAccountInfo: getAccountInfoForProgramOnly(),
      getSlot: vi.fn(async () => 1),
      getAddressLookupTable: vi.fn(async () => ({ value: null })),
      getBalance: vi.fn(async () => 50_000_000),
      getMinimumBalanceForRentExemption: vi.fn(async () => 2_039_280),
    } as any;

    const result = await executeOnce({
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
      config: {
        ...EXECUTE_CONFIG,
        execution: {
          ...EXECUTE_CONFIG.execution,
          swapRouter: 'noop',
          receiptPollMaxAttempts: 1,
        },
      },
      policyState: {},
      expectedMinOut: '0',
      quoteAgeMs: 0,
      signAndSend: vi.fn(async () => 'sig'),
      observer,
      checkExistingReceipt: async () => false,
    });

    expect(result.status).toBe('EXECUTED');
    const emittedEvents = observer.emit.mock.calls.map((args) => args[0] as { event: string; status: string });
    const triggerEvent = emittedEvents.find((event) => event.event.startsWith('policy.decision_trigger'));
    expect(triggerEvent?.status).toBe('ok');
  });

  it('maps runtime startup failures to config validation events and counters', async () => {
    const authority = new PublicKey(new Uint8Array(32).fill(20));
    const counters = createRuntimeCounterRegistry();
    const observer = { emit: vi.fn() };

    const result = await executeOnce({
      connection: {} as any,
      authority,
      position: new PublicKey(new Uint8Array(32).fill(21)),
      samples: [
        { slot: 1, unixTs: 1, currentTickIndex: 25 },
        { slot: 2, unixTs: 2, currentTickIndex: 26 },
        { slot: 3, unixTs: 3, currentTickIndex: 27 },
      ],
      config: EXECUTE_CONFIG,
      policyState: {},
      expectedMinOut: '0',
      quoteAgeMs: 0,
      signAndSend: vi.fn(async () => 'sig'),
      runtimeEnvironment: {
        rpcUrl: '',
      },
      observer,
      counters,
    });

    expect(result.status).toBe('ERROR');
    expect(result.errorCode).toBe('RPC_URL_MISSING');
    expect(observer.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'config.validation_failed',
        status: 'failed',
        errorCode: 'RPC_URL_MISSING',
      }),
    );
    expect(counters.snapshot().configValidationFailures).toBe(1);
    expect(counters.snapshot().snapshotFailures).toBe(0);
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
      getAccountInfo: getAccountInfoForProgramOnly(),
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
      config: { ...EXECUTE_CONFIG, execution: { ...EXECUTE_CONFIG.execution, swapRouter: 'jupiter' } },
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
      getAccountInfo: getAccountInfoForProgramOnly(),
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
      config: { ...EXECUTE_CONFIG, execution: { ...EXECUTE_CONFIG.execution, swapRouter: 'jupiter' } },
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
      getAccountInfo: getAccountInfoForProgramOnly(),
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
      config: { ...EXECUTE_CONFIG, execution: { ...EXECUTE_CONFIG.execution, swapRouter: 'jupiter' } },
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
      getAccountInfo: getAccountInfoForProgramOnly(),
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
      config: { ...EXECUTE_CONFIG, execution: { ...EXECUTE_CONFIG.execution, swapRouter: 'jupiter' } },
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
      getAccountInfo: getAccountInfoForProgramOnly(),
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
      config: { ...EXECUTE_CONFIG, execution: { ...EXECUTE_CONFIG.execution, swapRouter: 'orca' } },
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
      getAccountInfo: getAccountInfoForProgramOnly(),
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
      config: { ...EXECUTE_CONFIG, execution: { ...EXECUTE_CONFIG.execution, swapRouter: 'orca' } },
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
      getAccountInfo: getAccountInfoForProgramOnly(),
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
      config: { ...EXECUTE_CONFIG, execution: { ...EXECUTE_CONFIG.execution, swapRouter: 'jupiter' } },
      policyState: {},
      expectedMinOut: '0',
      quoteAgeMs: 0,
      attestationHash: new Uint8Array(32),
      attestationPayloadBytes: new Uint8Array(68),
      signAndSend: vi.fn(async (_tx: VersionedTransaction) => 'sig'),
      checkExistingReceipt: async () => false,
    });

    expect(res.status).toBe('ERROR');
    expect(res.errorCode).toBe('UNSUPPORTED_SWAP_ROUTE');
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
      getAccountInfo: getAccountInfoForProgramOnly(),
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
      config: { ...EXECUTE_CONFIG, execution: { ...EXECUTE_CONFIG.execution, swapRouter: 'jupiter' } },
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
      getAccountInfo: getAccountInfoForProgramOnly(),
      getSlot: vi.fn(async () => 1),
      getAddressLookupTable: vi.fn(async () => ({ value: null })),
    } as any;

    const res = await executeOnce({
      connection,
      authority,
      position: new PublicKey(new Uint8Array(32).fill(21)),
      samples: [
        { slot: 1, unixTs: 1, currentTickIndex: 15 },
        { slot: 2, unixTs: 2, currentTickIndex: 15 },
        { slot: 3, unixTs: 3, currentTickIndex: 15 },
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
      config: { ...EXECUTE_CONFIG, execution: { ...EXECUTE_CONFIG.execution, swapRouter: "noop" } },
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
    expect(res.metadata?.decision.decision).toBe('HOLD');
    expect(res.metadata?.swap.swapPlanned).toBe(false);
    expect(res.metadata?.executionIntent.receiptWritePlanned).toBe(false);
  });

  it('honors decisionOverride when live policy would otherwise HOLD', async () => {
    buildExitTransactionMock.mockClear();
    const authority = new PublicKey(new Uint8Array(32).fill(20));
    const connection = {
      getLatestBlockhash: vi.fn(async () => ({ blockhash: 'abc', lastValidBlockHeight: 123 })),
      confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
      simulateTransaction: vi.fn(async () => ({ value: { err: null } })),
      getAccountInfo: getAccountInfoForProgramOnly(),
      getSlot: vi.fn(async () => 1),
      getAddressLookupTable: vi.fn(async () => ({ value: null })),
      getBalance: vi.fn(async () => 50_000_000),
      getMinimumBalanceForRentExemption: vi.fn(async () => 2_039_280),
    } as any;

    const res = await executeOnce({
      connection,
      authority,
      position: new PublicKey(new Uint8Array(32).fill(21)),
      samples: [{ slot: 1, unixTs: 1, currentTickIndex: 11 }],
      decisionOverride: {
        decision: 'TRIGGER_DOWN',
        reasonCode: 'FORCED_TRIGGER_DOWN',
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
      config: {
        ...EXECUTE_CONFIG,
        execution: {
          ...EXECUTE_CONFIG.execution,
          swapRouter: 'noop',
          receiptPollMaxAttempts: 1,
        },
      },
      policyState: {},
      expectedMinOut: '0',
      quoteAgeMs: 0,
      attestationHash: new Uint8Array(32),
      attestationPayloadBytes: new Uint8Array(68),
      signAndSend: vi.fn(async (_tx: VersionedTransaction) => 'sig'),
      checkExistingReceipt: async () => false,
      nowUnixMs: () => 1_700_000_000_000,
    });

    expect(res.status).toBe('EXECUTED');
    expect(res.refresh?.decision.decision).toBe('TRIGGER_DOWN');
    expect(res.refresh?.decision.reasonCode).toBe('FORCED_TRIGGER_DOWN');
    expect(buildExitTransactionMock).toHaveBeenCalledWith(
      expect.anything(),
      'DOWN',
      expect.objectContaining({
        receiptProgramId: expect.any(PublicKey),
        receiptIdlPath: 'deployments/devnet/receipt.idl.json',
      }),
    );
  });

  it('fails fast when receipt program is not deployed, even if decision would be HOLD', async () => {
    buildExitTransactionMock.mockClear();
    vi.mocked(loadPositionSnapshot).mockClear();
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
      config: { ...EXECUTE_CONFIG, execution: { ...EXECUTE_CONFIG.execution, swapRouter: 'noop' } },
      policyState: {},
      expectedMinOut: '0',
      quoteAgeMs: 0,
      decisionOverride: { decision: 'TRIGGER_DOWN', reasonCode: 'TEST_FORCE' },
      attestationHash: new Uint8Array(32),
      attestationPayloadBytes: new Uint8Array(68),
      signAndSend: vi.fn(async (_tx: VersionedTransaction) => 'sig'),
    });

    expect(res.status).toBe('ERROR');
    expect(res.errorCode).toBe('RECEIPT_PROGRAM_VERIFICATION_FAILED');
    expect(loadPositionSnapshot).not.toHaveBeenCalled();
    expect(buildExitTransactionMock).not.toHaveBeenCalled();
  });

  it('fails fast on devnet when forced config identity is incomplete, even if decision would be HOLD', async () => {
    const prev = process.env.RECEIPT_IDENTITY_SOURCE;
    process.env.RECEIPT_IDENTITY_SOURCE = 'config';
    try {
      const authority = new PublicKey(new Uint8Array(32).fill(20));
      const connection = {
        getLatestBlockhash: vi.fn(async () => ({ blockhash: 'abc', lastValidBlockHeight: 123 })),
        confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
        simulateTransaction: vi.fn(async () => ({ value: { err: null } })),
        getAccountInfo: getAccountInfoForProgramOnly(),
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
        config: {
          ...EXECUTE_CONFIG,
          receiptProgramId: undefined,
          receiptIdlHashMode: undefined,
          receiptIdlHash: undefined,
          receiptIdlPath: undefined,
          execution: { ...EXECUTE_CONFIG.execution, swapRouter: 'noop' },
        },
        policyState: {},
        expectedMinOut: '0',
        quoteAgeMs: 0,
        attestationHash: new Uint8Array(32),
        attestationPayloadBytes: new Uint8Array(68),
        signAndSend: vi.fn(async (_tx: VersionedTransaction) => 'sig'),
      });

      expect(res.status).toBe('ERROR');
      expect(res.errorCode).toBe('RECEIPT_PROGRAM_NOT_CONFIGURED');
    } finally {
      if (prev === undefined) delete process.env.RECEIPT_IDENTITY_SOURCE;
      else process.env.RECEIPT_IDENTITY_SOURCE = prev;
    }
  });

  it('uses receiptIdentityEnv override instead of process.env for identity resolution', async () => {
    const prev = process.env.RECEIPT_IDENTITY_SOURCE;
    process.env.RECEIPT_IDENTITY_SOURCE = 'config';
    try {
      const authority = new PublicKey(new Uint8Array(32).fill(20));
      const connection = {
        getAccountInfo: getAccountInfoForProgramOnly(),
      } as any;

      const res = await executeOnce({
        connection,
        authority,
        receiptIdentityEnv: {},
        position: new PublicKey(new Uint8Array(32).fill(21)),
        samples: [{ slot: 1, unixTs: 1, currentTickIndex: 15 }],
        quote: {
          inputMint: new PublicKey('So11111111111111111111111111111111111111112'),
          outputMint: new PublicKey(DEVNET_USDC_MINT),
          inAmount: BigInt(1),
          outAmount: BigInt(1),
          slippageBps: 10,
          quotedAtUnixMs: Date.now(),
          raw: { inAmount: '1', outAmount: '1' },
        },
        config: {
          ...EXECUTE_CONFIG,
          receiptProgramId: undefined,
          receiptIdlHashMode: undefined,
          receiptIdlHash: undefined,
          receiptIdlPath: undefined,
          execution: { ...EXECUTE_CONFIG.execution, swapRouter: 'noop' },
        },
        policyState: {},
        expectedMinOut: '0',
        quoteAgeMs: 0,
        attestationHash: new Uint8Array(32),
        attestationPayloadBytes: new Uint8Array(68),
        signAndSend: vi.fn(async (_tx: VersionedTransaction) => 'sig'),
      });

      expect(res.status).toBe('HOLD');
    } finally {
      if (prev === undefined) delete process.env.RECEIPT_IDENTITY_SOURCE;
      else process.env.RECEIPT_IDENTITY_SOURCE = prev;
    }
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
      getAccountInfo: getAccountInfoForProgramOnly(),
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
      config: { ...EXECUTE_CONFIG, execution: { ...EXECUTE_CONFIG.execution, swapRouter: "noop" } },
      policyState: {},
      expectedMinOut: '0',
      quoteAgeMs: 0,
      decisionOverride: { decision: 'TRIGGER_DOWN', reasonCode: 'TEST_FORCE' },
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
      getAccountInfo: getAccountInfoForProgramOnly(),
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
      config: { ...EXECUTE_CONFIG, execution: { ...EXECUTE_CONFIG.execution, swapRouter: "noop" } },
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

    expect(res.status).toBe('ERROR');
    expect(res.errorCode).toBe('ALREADY_EXECUTED_THIS_EPOCH');
    expect(res.failurePhase).toBe('precheck');
    expect(buildExitTransactionMock).not.toHaveBeenCalled();
  });

  it('aborts before build when the on-chain receipt PDA already exists without using the legacy seam', async () => {
    vi.mocked(fetchReceiptByPda).mockResolvedValue(makeReceiptAccount());

    buildExitTransactionMock.mockClear();
    const authority = new PublicKey(new Uint8Array(32).fill(20));
    const connection = {
      getLatestBlockhash: vi.fn(async () => ({ blockhash: 'abc', lastValidBlockHeight: 123 })),
      confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
      simulateTransaction: vi.fn(async () => ({ value: { err: null } })),
      getAccountInfo: getAccountInfoForProgramOnly(),
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
      config: { ...EXECUTE_CONFIG, execution: { ...EXECUTE_CONFIG.execution, swapRouter: 'noop' } },
      policyState: {},
      expectedMinOut: '0',
      quoteAgeMs: 0,
      decisionOverride: { decision: 'TRIGGER_DOWN', reasonCode: 'TEST_FORCE' },
      attestationHash: new Uint8Array(32),
      attestationPayloadBytes: new Uint8Array(68),
      signAndSend: vi.fn(async (_tx: VersionedTransaction) => 'sig'),
    });

    expect(res.status).toBe('ERROR');
    expect(res.errorCode).toBe('ALREADY_EXECUTED_THIS_EPOCH');
    expect(res.metadata?.executionIntent.onChainReceiptVerified).toBe(true);
    expect(buildExitTransactionMock).not.toHaveBeenCalled();
  });

  it('fails and leaves a retryable local row when tx confirms but the on-chain receipt is never observed', async () => {
    vi.mocked(fetchReceiptByPda).mockResolvedValue(null);
    const receiptLedger = createSqliteLocalReceiptLedger(':memory:');
    const authority = new PublicKey(new Uint8Array(32).fill(20));
    const connection = {
      getLatestBlockhash: vi.fn(async () => ({ blockhash: 'abc', lastValidBlockHeight: 123 })),
      confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
      simulateTransaction: vi.fn(async () => ({ value: { err: null } })),
      getAccountInfo: getAccountInfoForProgramOnly(),
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
      config: {
        ...EXECUTE_CONFIG,
        execution: {
          ...EXECUTE_CONFIG.execution,
          swapRouter: 'noop',
          receiptPollMaxAttempts: 1,
        },
      },
      policyState: {},
      expectedMinOut: '0',
      quoteAgeMs: 0,
      attestationHash: new Uint8Array(32),
      attestationPayloadBytes: new Uint8Array(68),
      signAndSend: vi.fn(async (_tx: VersionedTransaction) => 'sig'),
      receiptLedger,
      nowUnixMs: () => 1_700_000_000_000,
    });

    const rows = receiptLedger.list();

    expect(res.status).toBe('ERROR');
    expect(res.errorCode).toBe('RPC_TRANSIENT');
    expect(res.errorMessage).toMatch(/receipt PDA/);
    expect(res.metadata?.executionIntent.localReceiptConfirmed).toBe(false);
    expect(res.metadata?.executionIntent.localReceiptStatus).toBe('failed');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.txSignature).toBe('sig');
    expect(rows[0]?.onChainReceiptVerified).toBe(false);
    expect(rows[0]?.lastErrorMessage).toMatch(/receipt PDA/);
    expect(
      receiptLedger.claim({
        cluster: rows[0]!.cluster,
        executionMode: rows[0]!.executionMode,
        authority: rows[0]!.authority,
        positionAddress: rows[0]!.positionAddress,
        positionMint: rows[0]!.positionMint,
        whirlpoolAddress: rows[0]!.whirlpoolAddress,
        epoch: rows[0]!.epoch,
        direction: rows[0]!.direction,
        attestationHash: new Uint8Array(32).fill(9),
        attestationPayloadBytes: new Uint8Array([9, 9, 9]),
        claimToken: 'retry-claim',
        nowUnixMs: 1_700_000_001_000,
        claimTtlMs: EXECUTE_CONFIG.execution.localReceiptClaimTtlMs,
        onChainReceiptEnabled: true,
        onChainReceiptPda: rows[0]!.onChainReceiptPda ?? undefined,
      }).kind,
    ).toBe('claimed');
    receiptLedger.close();
  });

  it('uses provided receiptEpochUnixMs for receipt precheck and tx builder', async () => {
    buildExitTransactionMock.mockClear();
    buildExitTransactionMock.mockResolvedValue({} as VersionedTransaction);
    const authority = new PublicKey(new Uint8Array(32).fill(20));
    const fixedReceiptEpochUnixMs = 172_800_000;
    const fixedEpoch = Math.floor(fixedReceiptEpochUnixMs / 1000 / 86400);
    const expectedProgramId = new PublicKey(DEFAULT_CONFIG.receiptProgramId!);
    const expectedPositionMint = new PublicKey(new Uint8Array(32).fill(3));
    const [expectedReceiptPda] = deriveReceiptPda({
      authority,
      positionMint: expectedPositionMint,
      epoch: fixedEpoch,
      programId: expectedProgramId,
    });
    const checkExistingReceipt = vi.fn(async (receiptPda: PublicKey) => {
      expect(receiptPda.toBase58()).toBe(expectedReceiptPda.toBase58());
      return false;
    });
    const connection = {
      getLatestBlockhash: vi.fn(async () => ({ blockhash: 'abc', lastValidBlockHeight: 123 })),
      confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
      simulateTransaction: vi.fn(async () => ({ value: { err: null } })),
      getAccountInfo: getAccountInfoForProgramOnly(),
      getSlot: vi.fn(async () => 1),
      getAddressLookupTable: vi.fn(async () => ({ value: null })),
      getBalance: vi.fn(async () => 50_000_000),
      getMinimumBalanceForRentExemption: vi.fn(async () => 2_039_280),
    } as any;

    const res = await executeOnce({
      connection,
      authority,
      receiptEpochUnixMs: fixedReceiptEpochUnixMs,
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
      config: {
        ...EXECUTE_CONFIG,
        execution: {
          ...EXECUTE_CONFIG.execution,
          swapRouter: "noop",
          receiptPollMaxAttempts: 1,
        },
      },
      policyState: {},
      expectedMinOut: '0',
      quoteAgeMs: 0,
      attestationHash: new Uint8Array(32),
      attestationPayloadBytes: new Uint8Array(68),
      signAndSend: vi.fn(async (_tx: VersionedTransaction) => 'sig'),
      checkExistingReceipt,
    });

    expect(res.status).toBe('EXECUTED');
    expect(checkExistingReceipt).toHaveBeenCalledTimes(1);
    expect(buildExitTransactionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        receiptEpochUnixMs: fixedReceiptEpochUnixMs,
      }),
    );
  });

  it('forces quote rebuild for certification stale-quote scenario', async () => {
    vi.mocked(loadPositionSnapshot).mockClear();
    vi.mocked(loadPositionSnapshot)
      .mockResolvedValueOnce({
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
        removePreview: { tokenAOut: BigInt(1), tokenBOut: BigInt(1) },
        removePreviewReasonCode: null,
      } as any)
      .mockResolvedValue({
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
        removePreview: { tokenAOut: BigInt(1), tokenBOut: BigInt(1) },
        removePreviewReasonCode: null,
      } as any);

    const authority = new PublicKey(new Uint8Array(32).fill(20));
    const connection = {
      getLatestBlockhash: vi.fn(async () => ({ blockhash: 'abc', lastValidBlockHeight: 123 })),
      confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
      simulateTransaction: vi.fn(async () => ({ value: { err: null } })),
      getAccountInfo: getAccountInfoForProgramOnly(),
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
      config: {
        ...EXECUTE_CONFIG,
        execution: {
          ...EXECUTE_CONFIG.execution,
          swapRouter: 'noop',
          receiptPollMaxAttempts: 1,
        },
      },
      policyState: {},
      expectedMinOut: '0',
      quoteAgeMs: 0,
      attestationHash: new Uint8Array(32),
      attestationPayloadBytes: new Uint8Array(68),
      signAndSend: vi.fn(async (_tx: VersionedTransaction) => 'sig'),
      checkExistingReceipt: async () => false,
      certificationHooks: { forceQuoteRebuildReason: 'QUOTE_STALE' },
    });

    expect(res.status).toBe('EXECUTED');
    expect(res.metadata?.reliability.quoteRebuilt).toBe(true);
    expect(res.metadata?.reliability.quoteRebuildReason).toBe('QUOTE_STALE');
    expect(vi.mocked(loadPositionSnapshot).mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('forces blockhash refresh for certification signing-delay scenario', async () => {
    const authority = new PublicKey(new Uint8Array(32).fill(20));
    const connection = {
      getLatestBlockhash: vi.fn(async () => ({ blockhash: 'abc', lastValidBlockHeight: 123 })),
      confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
      simulateTransaction: vi.fn(async () => ({ value: { err: null } })),
      getAccountInfo: getAccountInfoForProgramOnly(),
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
      config: {
        ...EXECUTE_CONFIG,
        execution: {
          ...EXECUTE_CONFIG.execution,
          swapRouter: 'noop',
          receiptPollMaxAttempts: 1,
        },
      },
      policyState: {},
      expectedMinOut: '0',
      quoteAgeMs: 0,
      attestationHash: new Uint8Array(32),
      attestationPayloadBytes: new Uint8Array(68),
      signAndSend: vi.fn(async (_tx: VersionedTransaction) => 'sig'),
      checkExistingReceipt: async () => false,
      certificationHooks: { forceBlockhashRefresh: true },
    });

    expect(res.status).toBe('EXECUTED');
    expect(res.metadata?.reliability.blockhashRefreshed).toBe(true);
    expect(connection.getLatestBlockhash).toHaveBeenCalledTimes(3);
  });

  it('forces retry exhaustion for certification rpc scenario', async () => {
    const authority = new PublicKey(new Uint8Array(32).fill(20));
    const sleep = vi.fn(async () => {});
    const connection = {
      getAccountInfo: getAccountInfoForProgramOnly(),
      getSlot: vi.fn(async () => 1),
      getBalance: vi.fn(async () => 50_000_000),
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
      config: { ...EXECUTE_CONFIG, execution: { ...EXECUTE_CONFIG.execution, swapRouter: 'noop' } },
      policyState: {},
      expectedMinOut: '0',
      quoteAgeMs: 0,
      decisionOverride: { decision: 'TRIGGER_DOWN', reasonCode: 'TEST_FORCE' },
      attestationHash: new Uint8Array(32),
      attestationPayloadBytes: new Uint8Array(68),
      signAndSend: vi.fn(async (_tx: VersionedTransaction) => 'sig'),
      sleep,
      certificationHooks: {
        forceRetryError: {
          key: 'buildPlan.initial',
          code: 'RPC_TRANSIENT',
          message: 'forced certification retry exhaustion',
          retryable: true,
        },
      },
    });

    expect(res.status).toBe('ERROR');
    expect(res.errorCode).toBe('RETRY_EXHAUSTED');
    expect(res.failurePhase).toBe('quote');
    expect(res.metadata?.reliability.retryAttempts['buildPlan.initial']).toBe(DEFAULT_CONFIG.execution.maxRetries);
    expect(res.metadata?.reliability.retryExhaustedKey).toBe('buildPlan.initial');
    expect(sleep).toHaveBeenCalledTimes(DEFAULT_CONFIG.execution.maxRetries - 1);
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
      getAccountInfo: getAccountInfoForProgramOnly(),
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
      config: { ...EXECUTE_CONFIG, execution: { ...EXECUTE_CONFIG.execution, swapRouter: "noop" } },
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
