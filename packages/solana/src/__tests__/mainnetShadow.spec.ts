import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '@clmm-autopilot/core';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Connection, PublicKey } from '@solana/web3.js';

const MAINNET_MANIFEST_FIXTURE = 'packages/solana/src/__tests__/fixtures/mainnet-receipt-manifest.json';
const AUTHORITY = new PublicKey(new Uint8Array(32).fill(6)).toBase58();
const POSITION = new PublicKey(new Uint8Array(32).fill(7)).toBase58();
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, '../../../..');
const tempDirs: string[] = [];

const { executeOnceMock, loadPositionSnapshotMock, verifyReceiptProgramOnChainMock } = vi.hoisted(() => ({
  executeOnceMock: vi.fn(),
  loadPositionSnapshotMock: vi.fn(),
  verifyReceiptProgramOnChainMock: vi.fn(),
}));

vi.mock('../index', () => ({
  createRuntimeCounterRegistry: vi.fn(() => ({
    increment: vi.fn(),
    snapshot: vi.fn(() => ({
      signerInvocations: 0,
      submitInvocations: 0,
      walletPromptCount: 0,
      shadowTxSignaturesEmitted: 0,
    })),
  })),
  executeOnce: executeOnceMock,
  loadPositionSnapshot: loadPositionSnapshotMock,
  ShadowSubmitter: class {
    readonly kind = 'shadow';

    constructor(_executionMode: string) {}

    async submit(): Promise<string> {
      throw new Error('Shadow submit should not be called in tests');
    }
  },
  classifyShadowSimulationResult: vi.fn(() => 'SIM_UNKNOWN'),
}));

vi.mock('../receiptProgramVerification', () => ({
  verifyReceiptProgramOnChain: verifyReceiptProgramOnChainMock,
}));

import { buildShadowTriggerRecord, isFatalShadowStartupCode, loadShadowConfig, runMainnetShadow } from '../mainnetShadow';

function shadowEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    SOLANA_RPC_URL: 'http://127.0.0.1:8899',
    SHADOW_AUTHORITY: AUTHORITY,
    SHADOW_POSITION_ADDRESSES: POSITION,
    SHADOW_DB_PATH: `/tmp/mainnet-shadow-test-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
    RECEIPT_MANIFEST_PATH: MAINNET_MANIFEST_FIXTURE,
    ...overrides,
  };
}

beforeEach(() => {
  executeOnceMock.mockReset();
  loadPositionSnapshotMock.mockReset();
  verifyReceiptProgramOnChainMock.mockReset();
  loadPositionSnapshotMock.mockResolvedValue({ currentTickIndex: 15 });
  verifyReceiptProgramOnChainMock.mockResolvedValue({
    programId: 'A81Xsuwg5zrT1sgvkncemfWqQ8nymwHS3e7ExM4YnXMm',
    owner: 'BPFLoaderUpgradeab1e11111111111111111111111',
  });
  vi.spyOn(Connection.prototype, 'getSlot').mockResolvedValue(1);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('buildShadowTriggerRecord', () => {
  it('persists the snapshot whirlpool address and explicit build status', () => {
    const authority = new PublicKey(new Uint8Array(32).fill(1));
    const params: Parameters<typeof buildShadowTriggerRecord>[0] = {
      sessionId: 'session-1',
      timestamp: '2026-03-13T00:00:00.000Z',
      config: {
        ...DEFAULT_CONFIG,
        cluster: 'mainnet',
        executionMode: 'mainnet-shadow',
        operator: {
          ...DEFAULT_CONFIG.operator,
          executionMode: 'mainnet-shadow',
          runtimeMode: 'simulate-only',
        },
      },
      authority,
      positionAddress: new PublicKey(new Uint8Array(32).fill(2)).toBase58(),
      positionSourceMode: 'configured' as const,
      refresh: {
        snapshot: {
          positionAddress: new PublicKey(new Uint8Array(32).fill(2)).toBase58(),
          whirlpoolAddress: new PublicKey(new Uint8Array(32).fill(3)).toBase58(),
          currentTick: 12,
          lowerTick: 10,
          upperTick: 20,
          inRange: false,
          pairLabel: 'SOL/USDC',
          pairValid: true,
          tokenProgramA: new PublicKey(new Uint8Array(32).fill(4)).toBase58(),
          tokenProgramB: new PublicKey(new Uint8Array(32).fill(5)).toBase58(),
        },
        decision: {
          decision: 'TRIGGER_UP' as const,
          reasonCode: 'OUT_OF_RANGE',
          samplesUsed: 3,
          threshold: 6000,
          cooldownRemainingMs: 0,
          nextState: {},
        },
        quote: {
          slippageBpsCap: 50,
          expectedMinOut: '1',
          quoteAgeMs: 10,
        },
      },
      result: {
        status: 'ERROR' as const,
        errorCode: 'SIMULATION_FAILED' as const,
        shadow: {
          txBuildStatus: 'BUILD_OK' as const,
          direction: 'trigger_up' as const,
          quoteSummary: {
            inAmount: '11',
            minOut: '22',
            slippageBps: 50,
            quoteAgeMs: 10,
          },
          candidateInstructionSummary: {
            removeLiquidityPlanned: true,
            collectFeesPlanned: true,
            swapInstructionCount: 2,
            onChainReceiptEnabled: false,
            receiptIxIncluded: false,
          },
          tokenProgramSummary: {
            mintAProgram: new PublicKey(new Uint8Array(32).fill(4)).toBase58(),
            mintBProgram: new PublicKey(new Uint8Array(32).fill(5)).toBase58(),
          },
          localReceiptStatus: 'clear' as const,
          onChainReceiptEnabled: false,
          onChainReceiptVerified: false,
          receiptPdaExpected: new PublicKey(new Uint8Array(32).fill(9)).toBase58(),
          receiptConfigValid: true,
          receiptStepStructurallyBuildable: true,
          receiptIxIncluded: false,
        },
      },
      simClass: 'SIM_UNKNOWN' as const,
      normalizedError: { code: 'SIMULATION_FAILED' as const },
    };

    const record = buildShadowTriggerRecord(params);

    expect(record.whirlpoolAddress).toBe(params.refresh.snapshot.whirlpoolAddress);
    expect(record.whirlpoolAddress).not.toBe(params.result.shadow!.receiptPdaExpected);
    expect(record.txBuildStatus).toBe('BUILD_OK');
  });
});

describe('loadShadowConfig', () => {
  it('defaults mainnet-shadow to local-ledger-only mode', () => {
    const config = loadShadowConfig({});

    expect(config.execution.onChainReceiptEnabled).toBe(false);
    expect(config.receiptProgramId).toBeUndefined();
  });

  it('ignores receipt manifest paths when on-chain receipts are disabled', () => {
    const config = loadShadowConfig({
      RECEIPT_MANIFEST_PATH: 'packages/solana/src/__tests__/fixtures/does-not-exist.json',
    });

    expect(config.execution.onChainReceiptEnabled).toBe(false);
  });

  it('rejects on-chain receipts in mainnet-shadow config', () => {
    expect(() =>
      loadShadowConfig({
        SHADOW_AUTOPILOT_CONFIG: JSON.stringify({
          cluster: 'mainnet',
          executionMode: 'mainnet-shadow',
          execution: { onChainReceiptEnabled: true },
        }),
      }),
    ).toThrow(/onChainReceiptEnabled/);
  });

  it('loads shadow config from a JSON file path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mainnet-shadow-config-'));
    tempDirs.push(dir);
    const configPath = join(dir, 'shadow.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        cluster: 'mainnet',
        executionMode: 'mainnet-shadow',
        policy: { cadenceMs: 15_000 },
        execution: { swapRouter: 'jupiter', sendEnabled: false, maxRetries: 1, retryBackoffMs: [2_000] },
      }),
      'utf8',
    );

    const config = loadShadowConfig({
      SHADOW_AUTOPILOT_CONFIG_PATH: configPath,
    });

    expect(config.policy.cadenceMs).toBe(15_000);
    expect(config.execution.maxRetries).toBe(1);
    expect(config.execution.retryBackoffMs).toEqual([2_000]);
  });

  it('prefers inline shadow config over the JSON file path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mainnet-shadow-config-'));
    tempDirs.push(dir);
    const configPath = join(dir, 'shadow.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        cluster: 'mainnet',
        executionMode: 'mainnet-shadow',
        policy: { cadenceMs: 15_000 },
      }),
      'utf8',
    );

    const config = loadShadowConfig({
      SHADOW_AUTOPILOT_CONFIG_PATH: configPath,
      SHADOW_AUTOPILOT_CONFIG: JSON.stringify({
        cluster: 'mainnet',
        executionMode: 'mainnet-shadow',
        policy: { cadenceMs: 30_000 },
      }),
    });

    expect(config.policy.cadenceMs).toBe(30_000);
  });
});

describe('isFatalShadowStartupCode', () => {
  it('marks receipt identity failures as fatal to the shadow runner', () => {
    expect(isFatalShadowStartupCode('RECEIPT_CONFIG_INCOMPLETE_FOR_SHADOW')).toBe(true);
    expect(isFatalShadowStartupCode('RECEIPT_IDL_MISMATCH')).toBe(true);
    expect(isFatalShadowStartupCode('SIMULATION_FAILED')).toBe(false);
  });
});

describe('runMainnetShadow', () => {
  it('does not verify the receipt program when on-chain receipts are disabled', async () => {
    const error = Object.assign(new Error('receipt program mismatch'), {
      code: 'RECEIPT_PROGRAM_VERIFICATION_FAILED' as const,
      retryable: false,
    });
    verifyReceiptProgramOnChainMock.mockRejectedValueOnce(error);
    executeOnceMock.mockResolvedValueOnce({
      status: 'ERROR',
      errorCode: 'RECEIPT_IDL_MISMATCH',
      errorMessage: 'manifest idl mismatch',
    });

    await expect(runMainnetShadow(shadowEnv())).rejects.toMatchObject({
      code: 'RECEIPT_IDL_MISMATCH',
    });
    expect(verifyReceiptProgramOnChainMock).not.toHaveBeenCalled();
    expect(loadPositionSnapshotMock).toHaveBeenCalledTimes(1);
    expect(executeOnceMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces startup-class executeOnce errors instead of silently continuing', async () => {
    executeOnceMock.mockResolvedValueOnce({
      status: 'ERROR',
      errorCode: 'RECEIPT_IDL_MISMATCH',
      errorMessage: 'manifest idl mismatch',
    });

    await expect(runMainnetShadow(shadowEnv())).rejects.toMatchObject({
      code: 'RECEIPT_IDL_MISMATCH',
    });
    expect(verifyReceiptProgramOnChainMock).not.toHaveBeenCalled();
    expect(loadPositionSnapshotMock).toHaveBeenCalledTimes(1);
    expect(executeOnceMock).toHaveBeenCalledTimes(1);
  });

  it('resolves relative shadow db paths from the repo root', async () => {
    executeOnceMock.mockResolvedValueOnce({
      status: 'ERROR',
      errorCode: 'RECEIPT_IDL_MISMATCH',
      errorMessage: 'manifest idl mismatch',
    });

    await expect(
      runMainnetShadow(
        shadowEnv({
          SHADOW_DB_PATH: 'artifacts/shadow/mainnet/custom-shadow.db',
        }),
      ),
    ).rejects.toMatchObject({
      code: 'RECEIPT_IDL_MISMATCH',
    });

    const startEvent = (console.log as unknown as { mock: { calls: string[][] } }).mock.calls
      .map(([entry]) => JSON.parse(entry) as { event?: string; dbPath?: string })
      .find((entry) => entry.event === 'shadow.start');

    expect(startEvent?.dbPath).toBe(resolve(REPO_ROOT, 'artifacts/shadow/mainnet/custom-shadow.db'));
  });
});
