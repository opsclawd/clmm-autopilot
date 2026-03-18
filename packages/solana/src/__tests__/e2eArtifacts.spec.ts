import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { getMintRegistry } from '@clmm-autopilot/core';
import { runDevnetE2EWithArtifact } from '../e2eDevnet';
import { deriveReceiptPda } from '../receipt';
import { getDefaultDevnetReceiptManifest } from '../receiptIdentity';

const SOL = new PublicKey('So11111111111111111111111111111111111111112');
const USDC = new PublicKey(getMintRegistry('devnet').usdc);
const BPF_UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function makeEnv(): Promise<{ env: Record<string, string>; authority: PublicKey }> {
  const dir = await mkdtemp(join(tmpdir(), 'm17-artifacts-'));
  cleanupDirs.push(dir);
  const kp = Keypair.generate();
  const keyPath = join(dir, 'authority.json');
  await writeFile(keyPath, JSON.stringify(Array.from(kp.secretKey)));
  return {
    authority: kp.publicKey,
    env: {
      RPC_URL: 'http://127.0.0.1:8899',
      AUTHORITY_KEYPAIR: keyPath,
      POSITION_ADDRESS: new PublicKey(new Uint8Array(32).fill(7)).toBase58(),
      LOCAL_RECEIPT_DB_PATH: join(dir, 'local-receipts.db'),
      FORCE_DECISION: 'TRIGGER_DOWN',
      SWAP_ROUTER: 'noop',
      E2E_ARTIFACT_DIR: join(dir, 'artifacts'),
    },
  };
}

function snapshot(position: PublicKey, feeOwedA: bigint, feeOwedB: bigint, liquidity: bigint) {
  return {
    cluster: 'devnet',
    pairLabel: 'SOL/USDC',
    pairValid: true,
    whirlpool: new PublicKey(new Uint8Array(32).fill(1)),
    position,
    positionMint: new PublicKey(new Uint8Array(32).fill(2)),
    currentTickIndex: 0,
    lowerTickIndex: -10,
    upperTickIndex: 10,
    tickSpacing: 1,
    inRange: true,
    liquidity,
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
    feeOwedA,
    feeOwedB,
  };
}

function deps(params: {
  authority: PublicKey;
  pre: ReturnType<typeof snapshot>;
  post: ReturnType<typeof snapshot>;
}) {
  const epoch = Math.floor((1_700_000_000_000 / 1000) / 86400);
  const manifestProgramId = new PublicKey(getDefaultDevnetReceiptManifest().programId);
  const [receiptPda] = deriveReceiptPda({
    authority: params.authority,
    positionMint: params.pre.positionMint,
    epoch,
    programId: manifestProgramId,
  });
  let attestationHash = new Uint8Array(32).fill(1);

  return {
    loadPositionSnapshot: vi
      .fn()
      .mockResolvedValueOnce(params.pre)
      .mockResolvedValueOnce(params.post) as any,
    fetchJupiterQuote: vi.fn() as any,
    executeOnce: vi.fn()
      .mockImplementationOnce(async (input: { attestationHash?: Uint8Array }) => {
        attestationHash = new Uint8Array(input.attestationHash ?? attestationHash);
        return {
          status: 'EXECUTED',
          txSignature: 'sig-1',
          receiptPda: receiptPda.toBase58(),
          execution: { unsignedTxBuilt: true, simulated: true },
          metadata: { executionIntent: { collectFeesPlanned: true } },
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
        authority: params.authority,
        positionMint: params.pre.positionMint,
        epoch,
        direction: 0,
        attestationHash,
        slot: 1n,
        unixTs: 1n,
        bump: 255,
      })) as any,
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
  } as any;
}

describe('runDevnetE2EWithArtifact fee semantics', () => {
  it('passes post.feesCollected with NO_FEES_ACCRUED when pre fees are zero', async () => {
    const { env, authority } = await makeEnv();
    const position = new PublicKey(env.POSITION_ADDRESS);
    const artifact = await runDevnetE2EWithArtifact(env, () => {}, deps({
      authority,
      pre: snapshot(position, 0n, 0n, 1n),
      post: snapshot(position, 0n, 0n, 0n),
    }));

    const feeAssertion = artifact.assertions.find((entry) => entry.name === 'post.feesCollected');
    expect(feeAssertion?.pass).toBe(true);
    expect(feeAssertion?.reasonCode).toBe('NO_FEES_ACCRUED');
  });

  it('fails post.feesCollected when pre fees are nonzero and no reset proof exists', async () => {
    const { env, authority } = await makeEnv();
    const position = new PublicKey(env.POSITION_ADDRESS);
    const artifact = await runDevnetE2EWithArtifact(env, () => {}, deps({
      authority,
      pre: snapshot(position, 10n, 5n, 1n),
      post: snapshot(position, 10n, 5n, 0n),
    }));

    const feeAssertion = artifact.assertions.find((entry) => entry.name === 'post.feesCollected');
    expect(feeAssertion?.pass).toBe(false);
    expect(feeAssertion?.reasonCode).toBe('FEE_PROOF_MISSING');
    expect(artifact.status).toBe('FAIL');
  });
});
