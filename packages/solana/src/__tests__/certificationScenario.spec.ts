import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { getMintRegistry } from '@clmm-autopilot/core';
import { runCertificationScenario } from '../e2eDevnet';

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
  it('classifies unsupported-router-cluster as EXPECTED_FAILURE', async () => {
    const env = await makeEnv();
    const artifact = await runCertificationScenario('unsupported-router-cluster', env, () => {}, deps());
    expect(artifact.status).toBe('EXPECTED_FAILURE');
    expect(artifact.scenarioName).toBe('unsupported-router-cluster');
  });

  it('marks token2022-certification as SKIPPED when token2022 position is not configured', async () => {
    const env = await makeEnv();
    const artifact = await runCertificationScenario('token2022-certification', env, () => {}, deps());
    expect(artifact.status).toBe('SKIPPED');
    expect(artifact.scenarioName).toBe('token2022-certification');
    expect(artifact.assertions.some((entry) => entry.reasonCode === 'SCENARIO_SKIPPED_NOT_CONFIGURED')).toBe(true);
  });
});
