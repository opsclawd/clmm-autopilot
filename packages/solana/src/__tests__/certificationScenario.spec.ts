import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { getMintRegistry } from '@clmm-autopilot/core';
import { runCertificationScenario } from '../e2eDevnet';
import { resolveCertificationScenarios } from '../e2e/scenarios';
import { deriveReceiptPda } from '../receipt';
import { getDefaultDevnetReceiptManifest } from '../receiptIdentity';

const SOL = new PublicKey('So11111111111111111111111111111111111111112');
const USDC = new PublicKey(getMintRegistry('devnet').usdc);
const BPF_UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function makeEnv(): Promise<Record<string, string>> {
  const dir = await mkdtemp(join(tmpdir(), 'm17-cert-'));
  dirs.push(dir);
  const keyPath = join(dir, 'authority.json');
  await writeFile(keyPath, JSON.stringify(Array.from(Keypair.generate().secretKey)));
  return {
    RPC_URL: 'http://127.0.0.1:8899',
    AUTHORITY_KEYPAIR: keyPath,
    POSITION_ADDRESS: new PublicKey(new Uint8Array(32).fill(7)).toBase58(),
    LOCAL_RECEIPT_DB_PATH: join(dir, 'local-receipts.db'),
    E2E_ARTIFACT_DIR: join(dir, 'artifacts'),
  };
}

function deps(overrides: Record<string, unknown> = {}): Parameters<typeof runCertificationScenario>[3] {
  return {
    loadPositionSnapshot: vi.fn(async () => ({
      cluster: 'devnet',
      pairLabel: 'SOL/USDC',
      pairValid: true,
      whirlpool: new PublicKey(new Uint8Array(32).fill(1)),
      position: new PublicKey(new Uint8Array(32).fill(7)),
      positionMint: new PublicKey(new Uint8Array(32).fill(2)),
      currentTickIndex: -50,
      lowerTickIndex: -10,
      upperTickIndex: 10,
      tickSpacing: 1,
      inRange: false,
      liquidity: 1n,
      tokenMintA: SOL,
      tokenMintB: USDC,
      tokenDecimalsA: 9,
      tokenDecimalsB: 6,
      tokenVaultA: new PublicKey(new Uint8Array(32).fill(3)),
      tokenVaultB: new PublicKey(new Uint8Array(32).fill(4)),
      tickArrayLower: new PublicKey(new Uint8Array(32).fill(5)),
      tickArrayUpper: new PublicKey(new Uint8Array(32).fill(6)),
      tokenProgramA: new PublicKey(new Uint8Array(32).fill(8)),
      tokenProgramB: new PublicKey(new Uint8Array(32).fill(9)),
      removePreview: { tokenAOut: 1000n, tokenBOut: 1000n },
      removePreviewReasonCode: null,
      feeOwedA: 0n,
      feeOwedB: 0n,
    })) as any,
    fetchJupiterQuote: vi.fn() as any,
    executeOnce: vi.fn() as any,
    fetchReceiptByPda: vi.fn(async () => null) as any,
    getSlot: vi.fn(async () => 123),
    getBalance: vi.fn(async () => 1_000_000_000),
    getAccountInfo: vi.fn(async () => ({
      executable: true,
      owner: BPF_UPGRADEABLE_LOADER,
      lamports: 1,
      data: Buffer.alloc(0),
      rentEpoch: 0,
    })) as any,
    getParsedAccountInfo: vi.fn(async () => ({ context: { slot: 1 }, value: null })) as any,
    getTransaction: vi.fn(async () => ({ meta: { fee: 5_000, err: null } })) as any,
    nowMs: () => 1_700_000_000_000,
    ...overrides,
  } as any;
}

describe('certification scenarios', () => {
  it('forces hold-path into HOLD without executing the tx path', async () => {
    const env = await makeEnv();
    const executeOnce = vi.fn();
    const artifact = await runCertificationScenario(resolveCertificationScenarios({
      scenarioId: 'hold-path-debounce',
      direction: 'DOWN',
    })[0], env, () => {}, deps({
      loadPositionSnapshot: vi.fn(async () => ({
        cluster: 'devnet',
        pairLabel: 'SOL/USDC',
        pairValid: true,
        whirlpool: new PublicKey(new Uint8Array(32).fill(1)),
        position: new PublicKey(new Uint8Array(32).fill(7)),
        positionMint: new PublicKey(new Uint8Array(32).fill(2)),
        currentTickIndex: 0,
        lowerTickIndex: -10,
        upperTickIndex: 10,
        tickSpacing: 1,
        inRange: true,
        liquidity: 1n,
        tokenMintA: SOL,
        tokenMintB: USDC,
        tokenDecimalsA: 9,
        tokenDecimalsB: 6,
        tokenVaultA: new PublicKey(new Uint8Array(32).fill(3)),
        tokenVaultB: new PublicKey(new Uint8Array(32).fill(4)),
        tickArrayLower: new PublicKey(new Uint8Array(32).fill(5)),
        tickArrayUpper: new PublicKey(new Uint8Array(32).fill(6)),
        tokenProgramA: new PublicKey(new Uint8Array(32).fill(8)),
        tokenProgramB: new PublicKey(new Uint8Array(32).fill(9)),
        removePreview: { tokenAOut: 1000n, tokenBOut: 1000n },
        removePreviewReasonCode: null,
        feeOwedA: 0n,
        feeOwedB: 0n,
      })) as any,
      executeOnce: executeOnce as any,
    }));

    expect(artifact.status).toBe('HOLD');
    expect(artifact.assertions.some((entry) => entry.name === 'scenario.statusMatchesExpected' && entry.pass)).toBe(true);
    expect(executeOnce).not.toHaveBeenCalled();
  });

  it('classifies unsupported-router-cluster as EXPECTED_FAILURE', async () => {
    const env = await makeEnv();
    const artifact = await runCertificationScenario(resolveCertificationScenarios({
      scenarioId: 'unsupported-router-cluster',
      direction: 'DOWN',
    })[0], env, () => {}, deps());
    expect(artifact.status).toBe('EXPECTED_FAILURE');
    expect(artifact.scenarioName).toBe('down-unsupported-router-cluster');
  });

  it('fails rpc-retry-exhaustion when the expected failure is not observed', async () => {
    const env = await makeEnv();
    let attestationHash = new Uint8Array(32).fill(1);
    const positionMint = new PublicKey(new Uint8Array(32).fill(2));
    const authority = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(await readFile(env.AUTHORITY_KEYPAIR, 'utf8'))),
    ).publicKey;
    const epoch = Math.floor((1_700_000_000_000 / 1000) / 86400);
    const [receiptPda] = deriveReceiptPda({
      authority,
      positionMint,
      epoch,
      programId: new PublicKey(getDefaultDevnetReceiptManifest().programId),
    });
    const artifact = await runCertificationScenario(resolveCertificationScenarios({
      scenarioId: 'rpc-retry-exhaustion',
      direction: 'DOWN',
    })[0], env, () => {}, deps({
      executeOnce: vi.fn()
        .mockImplementationOnce(async (input: { attestationHash?: Uint8Array }) => {
          attestationHash = new Uint8Array(input.attestationHash ?? attestationHash);
          return {
            status: 'EXECUTED',
            txSignature: 'sig-1',
            receiptPda: receiptPda.toBase58(),
            execution: { unsignedTxBuilt: true, simulated: true },
            metadata: {
              prompt: { state: 'signed', walletPromptCount: 1 },
              swap: { swapInstructionCount: 1 },
              executionIntent: { collectFeesPlanned: true, localReceiptStatus: 'confirmed', localReceiptClaimed: true, localReceiptConfirmed: true },
              reliability: {
                quoteRebuilt: false,
                quoteAgeMs: 0,
                quoteFreshnessMs: 1000,
                quoteFreshnessSlots: 2,
                blockhashRefreshed: false,
                sendAttempts: 1,
                retryAttempts: {},
              },
            },
          };
        })
        .mockResolvedValueOnce({
          status: 'ERROR',
          errorCode: 'ALREADY_EXECUTED_THIS_EPOCH',
          errorMessage: 'already done',
        }) as any,
      fetchReceiptByPda: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockImplementationOnce(async () => ({
          authority,
          positionMint,
          epoch,
          direction: 0,
          attestationHash,
          slot: 1n,
          unixTs: 1n,
          bump: 255,
        })) as any,
      loadPositionSnapshot: vi
        .fn()
        .mockResolvedValueOnce({
          cluster: 'devnet',
          pairLabel: 'SOL/USDC',
          pairValid: true,
          whirlpool: new PublicKey(new Uint8Array(32).fill(1)),
          position: new PublicKey(new Uint8Array(32).fill(7)),
          positionMint,
          currentTickIndex: -50,
          lowerTickIndex: -10,
          upperTickIndex: 10,
          tickSpacing: 1,
          inRange: false,
          liquidity: 1n,
          tokenMintA: SOL,
          tokenMintB: USDC,
          tokenDecimalsA: 9,
          tokenDecimalsB: 6,
          tokenVaultA: new PublicKey(new Uint8Array(32).fill(3)),
          tokenVaultB: new PublicKey(new Uint8Array(32).fill(4)),
          tickArrayLower: new PublicKey(new Uint8Array(32).fill(5)),
          tickArrayUpper: new PublicKey(new Uint8Array(32).fill(6)),
          tokenProgramA: new PublicKey(new Uint8Array(32).fill(8)),
          tokenProgramB: new PublicKey(new Uint8Array(32).fill(9)),
          removePreview: { tokenAOut: 1000n, tokenBOut: 1000n },
          removePreviewReasonCode: null,
          feeOwedA: 0n,
          feeOwedB: 0n,
        })
        .mockResolvedValueOnce({
          cluster: 'devnet',
          pairLabel: 'SOL/USDC',
          pairValid: true,
          whirlpool: new PublicKey(new Uint8Array(32).fill(1)),
          position: new PublicKey(new Uint8Array(32).fill(7)),
          positionMint,
          currentTickIndex: -50,
          lowerTickIndex: -10,
          upperTickIndex: 10,
          tickSpacing: 1,
          inRange: false,
          liquidity: 0n,
          tokenMintA: SOL,
          tokenMintB: USDC,
          tokenDecimalsA: 9,
          tokenDecimalsB: 6,
          tokenVaultA: new PublicKey(new Uint8Array(32).fill(3)),
          tokenVaultB: new PublicKey(new Uint8Array(32).fill(4)),
          tickArrayLower: new PublicKey(new Uint8Array(32).fill(5)),
          tickArrayUpper: new PublicKey(new Uint8Array(32).fill(6)),
          tokenProgramA: new PublicKey(new Uint8Array(32).fill(8)),
          tokenProgramB: new PublicKey(new Uint8Array(32).fill(9)),
          removePreview: { tokenAOut: 1000n, tokenBOut: 1000n },
          removePreviewReasonCode: null,
          feeOwedA: 0n,
          feeOwedB: 0n,
        }) as any,
    }));

    expect(artifact.status).toBe('FAIL');
    expect(artifact.errors.some((entry) => entry.code === 'CERT_EXPECTED_FAILURE_NOT_OBSERVED')).toBe(true);
  });
});
