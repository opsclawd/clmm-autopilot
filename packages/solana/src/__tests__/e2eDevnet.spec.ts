import { afterEach, describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getMintRegistry } from '@clmm-autopilot/core';
import { runDevnetE2E } from '../e2eDevnet';
import { createSqliteLocalReceiptLedger } from '../localReceiptLedger';
import { deriveReceiptPda } from '../receipt';
import { getDefaultDevnetReceiptManifest } from '../receiptIdentity';

const SOL = new PublicKey('So11111111111111111111111111111111111111112');
const USDC = new PublicKey(getMintRegistry('devnet').usdc);
const NOT_USDC = new PublicKey('Es9vMFrzaCERmJfrF4H2FYD8fYF8f3L7hPwrKyYVJZZW');
const BPF_UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

async function makeEnv(secret?: string): Promise<{ env: Record<string, string>; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'm12-e2e-'));
  const keyPath = join(dir, 'authority.json');
  if (secret !== undefined) {
    await writeFile(keyPath, secret);
  } else {
    const kp = Keypair.generate();
    await writeFile(keyPath, JSON.stringify(Array.from(kp.secretKey)));
  }

  return {
    env: {
      RPC_URL: 'http://127.0.0.1:8899',
      AUTHORITY_KEYPAIR: keyPath,
      POSITION_ADDRESS: new PublicKey(new Uint8Array(32).fill(7)).toBase58(),
      LOCAL_RECEIPT_DB_PATH: join(dir, 'local-receipts.db'),
      E2E_ARTIFACT_DIR: join(dir, 'artifacts'),
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

function mockSnapshot(positionAddress: string, overrides: Partial<any> = {}) {
  return {
    cluster: 'devnet',
    pairLabel: 'SOL/USDC',
    pairValid: true,
    whirlpool: new PublicKey(new Uint8Array(32).fill(1)),
    position: new PublicKey(positionAddress),
    positionMint: new PublicKey(new Uint8Array(32).fill(2)),
    currentTickIndex: -50,
    lowerTickIndex: -10,
    upperTickIndex: 10,
    tickSpacing: 1,
    inRange: false,
    liquidity: BigInt(1),
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
    removePreview: { tokenAOut: BigInt(1000), tokenBOut: BigInt(1000) },
    removePreviewReasonCode: null,
    feeOwedA: 0n,
    feeOwedB: 0n,
    ...overrides,
  };
}

function harnessDeps(overrides: Partial<Parameters<typeof runDevnetE2E>[2]> = {}): Parameters<typeof runDevnetE2E>[2] {
  return {
    loadPositionSnapshot: vi.fn(async () => mockSnapshot(new PublicKey(new Uint8Array(32).fill(7)).toBase58())) as any,
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
  };
}

describe('runDevnetE2E refusals', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses with NOT_SOL_USDC and does not execute tx path', async () => {
    const { env, cleanup } = await makeEnv();
    const executeOnce = vi.fn();

    await expect(
      runDevnetE2E(env, () => {}, harnessDeps({
        loadPositionSnapshot: vi.fn(async () => mockSnapshot(env.POSITION_ADDRESS, {
          tokenMintB: NOT_USDC,
          pairLabel: 'SOL/USDT',
        })) as any,
        fetchJupiterQuote: vi.fn() as any,
        executeOnce: executeOnce as any,
        fetchReceiptByPda: vi.fn() as any,
        getSlot: vi.fn(async () => 123),
        nowMs: () => 1_700_000_000_000,
      })),
    ).rejects.toMatchObject({ code: 'NOT_SOL_USDC' });

    expect(executeOnce).not.toHaveBeenCalled();
    await cleanup();
  });

  it('uses canonical devnet USDC fixture mint', () => {
    expect(USDC.toBase58()).toBe(getMintRegistry('devnet').usdc);
  });

  it('refuses with ALREADY_EXECUTED_THIS_EPOCH before executeOnce', async () => {
    const { env, cleanup } = await makeEnv();
    const executeOnce = vi.fn();

    await expect(
      runDevnetE2E(env, () => {}, harnessDeps({
        loadPositionSnapshot: vi.fn(async () => mockSnapshot(env.POSITION_ADDRESS)) as any,
        fetchJupiterQuote: vi.fn(async () => ({
          inputMint: SOL,
          outputMint: USDC,
          inAmount: BigInt(1000),
          outAmount: BigInt(1000),
          slippageBps: 50,
          quotedAtUnixMs: 1_700_000_000_000,
          raw: {},
        })) as any,
        executeOnce: executeOnce as any,
        fetchReceiptByPda: vi.fn(async () => ({
          authority: new PublicKey(new Uint8Array(32).fill(10)),
          positionMint: new PublicKey(new Uint8Array(32).fill(11)),
          epoch: 1,
          direction: 0,
          attestationHash: new Uint8Array(32),
          slot: BigInt(1),
          unixTs: BigInt(1),
          bump: 255,
        })) as any,
        getSlot: vi.fn(async () => 123),
        nowMs: () => 1_700_000_000_000,
      })),
    ).rejects.toMatchObject({ code: 'ALREADY_EXECUTED_THIS_EPOCH' });

    expect(executeOnce).not.toHaveBeenCalled();
    await cleanup();
  });

  it('returns CONFIG_INVALID when env is missing', async () => {
    const { env, cleanup } = await makeEnv();
    delete env.RPC_URL;

    await expect(runDevnetE2E(env, () => {})).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await cleanup();
  });

  it('returns CONFIG_INVALID when no position source is configured', async () => {
    const { env, cleanup } = await makeEnv();
    delete env.POSITION_ADDRESS;

    await expect(runDevnetE2E(env, () => {})).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await cleanup();
  });

  it('returns CONFIG_INVALID when FORCE_DECISION is malformed', async () => {
    const { env, cleanup } = await makeEnv();
    env.FORCE_DECISION = 'bad-value';

    await expect(runDevnetE2E(env, () => {})).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await cleanup();
  });

  it('fails fast when REQUIRE_RECEIPT_PROOF=1 and policy stays HOLD', async () => {
    const { env, cleanup } = await makeEnv();
    env.REQUIRE_RECEIPT_PROOF = '1';
    const executeOnce = vi.fn();

    await expect(
      runDevnetE2E(env, () => {}, harnessDeps({
        loadPositionSnapshot: vi.fn(async () => mockSnapshot(env.POSITION_ADDRESS, {
          currentTickIndex: 0,
          lowerTickIndex: -10,
          upperTickIndex: 10,
          inRange: true,
        })) as any,
        executeOnce: executeOnce as any,
      })),
    ).rejects.toMatchObject({ code: 'RECEIPT_PROGRAM_VERIFICATION_FAILED' });

    expect(executeOnce).not.toHaveBeenCalled();
    await cleanup();
  });

  it('treats optional token2022 scenario as non-blocking on HOLD', async () => {
    const { env, cleanup } = await makeEnv();
    env.TOKEN2022_POSITION_ADDRESS = 'not-a-pubkey';
    const logs: Array<Record<string, unknown>> = [];

    await expect(
      runDevnetE2E(
        env,
        (entry) => logs.push(entry),
        harnessDeps({
          loadPositionSnapshot: vi.fn(async () => mockSnapshot(env.POSITION_ADDRESS, {
            currentTickIndex: 0,
            lowerTickIndex: -10,
            upperTickIndex: 10,
            inRange: true,
          })) as any,
        }),
      ),
    ).resolves.toBeUndefined();

    expect(logs.some((entry) => entry.step === 'token2022.optional.skip')).toBe(true);
    expect(logs.some((entry) => entry.step === 'harness.complete' && entry.status === 'HOLD')).toBe(true);
    await cleanup();
  });

  it('forwards FORCE_DECISION into executeOnce when live policy would otherwise HOLD', async () => {
    const { env, cleanup } = await makeEnv();
    env.FORCE_DECISION = 'TRIGGER_DOWN';
    const runtimeEnv = { ...env, SWAP_ROUTER: 'noop' };
    const authority = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(await (await import('node:fs/promises')).readFile(env.AUTHORITY_KEYPAIR, 'utf8'))),
    ).publicKey;
    const snapshot = mockSnapshot(env.POSITION_ADDRESS, {
      currentTickIndex: 0,
      lowerTickIndex: -10,
      upperTickIndex: 10,
      inRange: true,
    });
    const nowMs = 1_700_000_000_000;
    const epoch = Math.floor((nowMs / 1000) / 86400);
    const manifestProgramId = new PublicKey(getDefaultDevnetReceiptManifest().programId);
    const [receiptPda] = deriveReceiptPda({
      authority,
      positionMint: snapshot.positionMint,
      epoch,
      programId: manifestProgramId,
    });

    let attestationHash = new Uint8Array(32).fill(1);
    const executeOnce = vi.fn()
      .mockImplementationOnce(async (params: {
        attestationHash?: Uint8Array;
        receiptEpochUnixMs?: number;
        decisionOverride?: { decision: string; reasonCode?: string };
        receiptIdentityEnv?: Record<string, string | undefined>;
      }) => {
        expect(params.decisionOverride).toEqual({
          decision: 'TRIGGER_DOWN',
          reasonCode: 'FORCED_TRIGGER_DOWN',
        });
        expect(params.receiptEpochUnixMs).toBe(nowMs);
        expect(params.receiptIdentityEnv).toBe(runtimeEnv);
        attestationHash = new Uint8Array(params.attestationHash ?? attestationHash);
        return {
          status: 'EXECUTED',
          txSignature: 'sig-forced',
          receiptPda: receiptPda.toBase58(),
        };
      })
      .mockImplementationOnce(async (params: {
        receiptEpochUnixMs?: number;
        decisionOverride?: { decision: string; reasonCode?: string };
        receiptIdentityEnv?: Record<string, string | undefined>;
      }) => {
        expect(params.decisionOverride).toEqual({
          decision: 'TRIGGER_DOWN',
          reasonCode: 'FORCED_TRIGGER_DOWN',
        });
        expect(params.receiptEpochUnixMs).toBe(nowMs);
        expect(params.receiptIdentityEnv).toBe(runtimeEnv);
        return {
          status: 'ERROR',
          errorCode: 'ALREADY_EXECUTED_THIS_EPOCH',
          errorMessage: 'already done',
        };
      });

    await expect(
      runDevnetE2E(
        runtimeEnv,
        () => {},
        harnessDeps({
          loadPositionSnapshot: vi
            .fn()
            .mockResolvedValueOnce(snapshot)
            .mockResolvedValueOnce({ ...snapshot, liquidity: 0n }) as any,
          executeOnce: executeOnce as any,
          fetchReceiptByPda: vi
            .fn()
            .mockResolvedValueOnce(null)
            .mockImplementationOnce(async () => ({
              authority,
              positionMint: snapshot.positionMint,
              epoch,
              direction: 0,
              attestationHash,
              slot: BigInt(1),
              unixTs: BigInt(1),
              bump: 255,
            })) as any,
          nowMs: () => nowMs,
        }),
      ),
    ).resolves.toBeUndefined();

    expect(executeOnce).toHaveBeenCalledTimes(2);
    await cleanup();
  });

  it('fails with RECEIPT_PROGRAM_VERIFICATION_FAILED when program account is missing', async () => {
    const { env, cleanup } = await makeEnv();
    const executeOnce = vi.fn();

    await expect(
      runDevnetE2E(
        env,
        () => {},
        harnessDeps({
          getAccountInfo: vi.fn(async () => null) as any,
          executeOnce: executeOnce as any,
        }),
      ),
    ).rejects.toMatchObject({ code: 'RECEIPT_PROGRAM_VERIFICATION_FAILED' });

    expect(executeOnce).not.toHaveBeenCalled();
    await cleanup();
  });

  it('fails fast on unsupported router/cluster before policy evaluation', async () => {
    const { env, cleanup } = await makeEnv();
    env.SWAP_ROUTER = 'jupiter';
    const loadPositionSnapshot = vi.fn(async () => mockSnapshot(env.POSITION_ADDRESS));
    const executeOnce = vi.fn();

    await expect(
      runDevnetE2E(env, () => {}, harnessDeps({
        loadPositionSnapshot: loadPositionSnapshot as any,
        fetchJupiterQuote: vi.fn() as any,
        executeOnce: executeOnce as any,
        fetchReceiptByPda: vi.fn() as any,
        getSlot: vi.fn(async () => 123),
        nowMs: () => 1_700_000_000_000,
      })),
    ).rejects.toMatchObject({ code: 'SWAP_ROUTER_UNSUPPORTED_CLUSTER' });

    expect(loadPositionSnapshot).not.toHaveBeenCalled();
    expect(executeOnce).not.toHaveBeenCalled();
    await cleanup();
  });


  it('returns INVALID_KEYPAIR when keypair bytes are out of range', async () => {
    const bad = JSON.stringify(new Array(64).fill(0).map((v, i) => (i === 10 ? 999 : v)));
    const { env, cleanup } = await makeEnv(bad);

    await expect(runDevnetE2E(env, () => {})).rejects.toMatchObject({ code: 'INVALID_KEYPAIR' });
    await cleanup();
  });

  it('returns CONFIG_INVALID when POSITION_ADDRESS is malformed', async () => {
    const { env, cleanup } = await makeEnv();
    env.POSITION_ADDRESS = 'not-a-pubkey';

    await expect(runDevnetE2E(env, () => {})).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await cleanup();
  });
  it('returns INVALID_KEYPAIR when keypair JSON is malformed', async () => {
    const { env, cleanup } = await makeEnv('{not valid json');

    await expect(runDevnetE2E(env, () => {})).rejects.toMatchObject({ code: 'INVALID_KEYPAIR' });
    await cleanup();
  });

  it('returns DATA_UNAVAILABLE when removePreview is missing', async () => {
    const { env, cleanup } = await makeEnv();
    const executeOnce = vi.fn();
    const fetchJupiterQuote = vi.fn();

    await expect(
      runDevnetE2E(env, () => {}, harnessDeps({
        loadPositionSnapshot: vi.fn(async () => mockSnapshot(env.POSITION_ADDRESS, { removePreview: null })) as any,
        fetchJupiterQuote: fetchJupiterQuote as any,
        executeOnce: executeOnce as any,
        fetchReceiptByPda: vi.fn(async () => null) as any,
        getSlot: vi.fn(async () => 123),
        nowMs: () => 1_700_000_000_000,
      })),
    ).rejects.toMatchObject({ code: 'DATA_UNAVAILABLE' });

    expect(fetchJupiterQuote).not.toHaveBeenCalled();
    expect(executeOnce).not.toHaveBeenCalled();
    await cleanup();
  });

  it('returns DATA_UNAVAILABLE when receipt is missing after confirmed send', async () => {
    const { env, cleanup } = await makeEnv();
    const authority = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(await (await import('node:fs/promises')).readFile(env.AUTHORITY_KEYPAIR, 'utf8'))),
    ).publicKey;
    const snapshot = mockSnapshot(env.POSITION_ADDRESS);
    const epoch = Math.floor((1_700_000_000_000 / 1000) / 86400);
    const manifestProgramId = new PublicKey(getDefaultDevnetReceiptManifest().programId);
    const [receiptPda] = deriveReceiptPda({
      authority,
      positionMint: snapshot.positionMint,
      epoch,
      programId: manifestProgramId,
    });
    const fetchReceiptByPda = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    await expect(
      runDevnetE2E(env, () => {}, harnessDeps({
        loadPositionSnapshot: vi.fn(async () => snapshot) as any,
        fetchJupiterQuote: vi.fn(async () => ({
          inputMint: SOL,
          outputMint: USDC,
          inAmount: BigInt(1000),
          outAmount: BigInt(1000),
          slippageBps: 50,
          quotedAtUnixMs: 1_700_000_000_000,
          raw: {},
        })) as any,
        executeOnce: vi.fn(async () => ({
          status: 'EXECUTED',
          txSignature: 'sig-1',
          receiptPda: receiptPda.toBase58(),
        })) as any,
        fetchReceiptByPda: fetchReceiptByPda as any,
        getSlot: vi.fn(async () => 123),
        nowMs: () => 1_700_000_000_000,
      })),
    ).rejects.toMatchObject({ code: 'DATA_UNAVAILABLE' });

    await cleanup();
  });

  it('returns LOCAL_RECEIPT_PENDING when a fresh local receipt claim already exists', async () => {
    const { env, cleanup } = await makeEnv();
    const authority = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(await (await import('node:fs/promises')).readFile(env.AUTHORITY_KEYPAIR, 'utf8'))),
    ).publicKey;
    const snapshot = mockSnapshot(env.POSITION_ADDRESS);
    const epoch = Math.floor((1_700_000_000_000 / 1000) / 86400);
    const ledger = createSqliteLocalReceiptLedger(env.LOCAL_RECEIPT_DB_PATH);
    ledger.claim({
      cluster: 'devnet',
      authority: authority.toBase58(),
      positionMint: snapshot.positionMint.toBase58(),
      epoch,
      executionMode: 'devnet-live',
      positionAddress: snapshot.position.toBase58(),
      whirlpoolAddress: snapshot.whirlpool.toBase58(),
      direction: 'DOWN',
      attestationHash: new Uint8Array(32).fill(7),
      attestationPayloadBytes: new Uint8Array([7]),
      claimToken: 'pending-claim',
      nowUnixMs: 1_700_000_000_000,
      claimTtlMs: 60_000,
      onChainReceiptEnabled: true,
    });
    ledger.close();

    await expect(
      runDevnetE2E(env, () => {}, harnessDeps({
        loadPositionSnapshot: vi.fn(async () => snapshot) as any,
      })),
    ).rejects.toMatchObject({ code: 'LOCAL_RECEIPT_PENDING' });

    await cleanup();
  });

  it('uses POSITION_ADDRESS_CANDIDATES to skip used positions and pick a fresh one', async () => {
    const { env, cleanup } = await makeEnv();
    delete env.POSITION_ADDRESS;
    const usedPosition = new PublicKey(new Uint8Array(32).fill(41)).toBase58();
    const freshPosition = new PublicKey(new Uint8Array(32).fill(42)).toBase58();
    env.POSITION_ADDRESS_CANDIDATES = `${usedPosition},${freshPosition}`;
    const authority = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(await (await import('node:fs/promises')).readFile(env.AUTHORITY_KEYPAIR, 'utf8'))),
    ).publicKey;
    const nowMs = 1_700_000_000_000;
    const epoch = Math.floor((nowMs / 1000) / 86400);
    const usedSnapshot = mockSnapshot(usedPosition, {
      positionMint: new PublicKey(new Uint8Array(32).fill(43)),
    });
    const freshSnapshot = mockSnapshot(freshPosition, {
      positionMint: new PublicKey(new Uint8Array(32).fill(44)),
    });
    const manifestProgramId = new PublicKey(getDefaultDevnetReceiptManifest().programId);
    const [usedReceiptPda] = deriveReceiptPda({
      authority,
      positionMint: usedSnapshot.positionMint,
      epoch,
      programId: manifestProgramId,
    });
    const [freshReceiptPda] = deriveReceiptPda({
      authority,
      positionMint: freshSnapshot.positionMint,
      epoch,
      programId: manifestProgramId,
    });

    let attestationHash = new Uint8Array(32).fill(1);
    const loadPositionSnapshot = vi.fn()
      .mockResolvedValueOnce(usedSnapshot)
      .mockResolvedValueOnce(freshSnapshot)
      .mockResolvedValueOnce({ ...freshSnapshot, liquidity: 0n });
    const fetchReceiptByPda = vi.fn()
      .mockResolvedValueOnce({
        authority,
        positionMint: usedSnapshot.positionMint,
        epoch,
        direction: 0,
        attestationHash: new Uint8Array(32),
        slot: BigInt(1),
        unixTs: BigInt(1),
        bump: 255,
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockImplementationOnce(async () => ({
        authority,
        positionMint: freshSnapshot.positionMint,
        epoch,
        direction: 0,
        attestationHash,
        slot: BigInt(1),
        unixTs: BigInt(1),
        bump: 255,
      }));
    const executeOnce = vi.fn()
      .mockImplementationOnce(async (params: { position: PublicKey; attestationHash?: Uint8Array; receiptEpochUnixMs?: number }) => {
        expect(params.position.toBase58()).toBe(freshPosition);
        expect(params.receiptEpochUnixMs).toBe(nowMs);
        attestationHash = new Uint8Array(params.attestationHash ?? attestationHash);
        return {
          status: 'EXECUTED',
          txSignature: 'sig-candidate',
          receiptPda: freshReceiptPda.toBase58(),
        };
      })
      .mockResolvedValueOnce({
        status: 'ERROR',
        errorCode: 'ALREADY_EXECUTED_THIS_EPOCH',
        errorMessage: 'already done',
      });

    await expect(
      runDevnetE2E(
        { ...env, SWAP_ROUTER: 'noop' },
        () => {},
        harnessDeps({
          loadPositionSnapshot: loadPositionSnapshot as any,
          executeOnce: executeOnce as any,
          fetchReceiptByPda: fetchReceiptByPda as any,
          nowMs: () => nowMs,
        }),
      ),
    ).resolves.toBeUndefined();

    expect(loadPositionSnapshot).toHaveBeenCalledTimes(3);
    expect(loadPositionSnapshot).toHaveBeenNthCalledWith(1, expect.anything(), new PublicKey(usedPosition), 'devnet');
    expect(loadPositionSnapshot).toHaveBeenNthCalledWith(2, expect.anything(), new PublicKey(freshPosition), 'devnet');
    expect(loadPositionSnapshot).toHaveBeenNthCalledWith(3, expect.anything(), new PublicKey(freshPosition), 'devnet');
    expect(fetchReceiptByPda).toHaveBeenNthCalledWith(1, expect.anything(), usedReceiptPda);
    expect(fetchReceiptByPda).toHaveBeenNthCalledWith(2, expect.anything(), freshReceiptPda);
    expect(fetchReceiptByPda).toHaveBeenNthCalledWith(3, expect.anything(), freshReceiptPda);
    await cleanup();
  });

  it('returns RECEIPT_MISMATCH when fetched receipt hash does not match local hash', async () => {
    const { env, cleanup } = await makeEnv();
    const authority = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(await (await import('node:fs/promises')).readFile(env.AUTHORITY_KEYPAIR, 'utf8'))),
    ).publicKey;
    const snapshot = mockSnapshot(env.POSITION_ADDRESS);

    const fetchReceiptByPda = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        authority,
        positionMint: snapshot.positionMint,
        epoch: Math.floor((1_700_000_000_000 / 1000) / 86400),
        direction: 0,
        attestationHash: new Uint8Array(32).fill(99),
        slot: BigInt(1),
        unixTs: BigInt(1),
        bump: 255,
      });

    await expect(
      runDevnetE2E(env, () => {}, harnessDeps({
        loadPositionSnapshot: vi.fn(async () => snapshot) as any,
        fetchJupiterQuote: vi.fn(async () => ({
          inputMint: SOL,
          outputMint: USDC,
          inAmount: BigInt(1000),
          outAmount: BigInt(1000),
          slippageBps: 50,
          quotedAtUnixMs: 1_700_000_000_000,
          raw: {},
        })) as any,
        executeOnce: vi.fn(async () => ({
          status: 'EXECUTED',
          txSignature: 'sig-2',
          receiptPda: new PublicKey(new Uint8Array(32).fill(12)).toBase58(),
        })) as any,
        fetchReceiptByPda: fetchReceiptByPda as any,
        getSlot: vi.fn(async () => 123),
        nowMs: () => 1_700_000_000_000,
      })),
    ).rejects.toMatchObject({ code: 'RECEIPT_MISMATCH' });

    await cleanup();
  });

  it('proves duplicate execution is blocked after 0->1 receipt transition', async () => {
    const { env, cleanup } = await makeEnv();
    const authority = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(await (await import('node:fs/promises')).readFile(env.AUTHORITY_KEYPAIR, 'utf8'))),
    ).publicKey;
    const snapshot = mockSnapshot(env.POSITION_ADDRESS);
    const nowMs = 1_700_000_000_000;
    const epoch = Math.floor((nowMs / 1000) / 86400);
    const manifestProgramId = new PublicKey(getDefaultDevnetReceiptManifest().programId);
    const [receiptPda] = deriveReceiptPda({
      authority,
      positionMint: snapshot.positionMint,
      epoch,
      programId: manifestProgramId,
    });

    let attestationHash = new Uint8Array(32).fill(1);
    const executeOnce = vi.fn()
      .mockImplementationOnce(async (params: { attestationHash?: Uint8Array; receiptEpochUnixMs?: number }) => {
        expect(params.receiptEpochUnixMs).toBe(nowMs);
        const runtimeHash = params.attestationHash ?? attestationHash;
        attestationHash = new Uint8Array(runtimeHash);
        return {
          status: 'EXECUTED',
          txSignature: 'sig-ok',
          receiptPda: receiptPda.toBase58(),
        };
      })
      .mockImplementationOnce(async (params: { receiptEpochUnixMs?: number }) => {
        expect(params.receiptEpochUnixMs).toBe(nowMs);
        return {
          status: 'ERROR',
          errorCode: 'ALREADY_EXECUTED_THIS_EPOCH',
          errorMessage: 'already done',
        };
      });

    await expect(
      runDevnetE2E(
        { ...env, SWAP_ROUTER: 'noop' },
        () => {},
        harnessDeps({
          loadPositionSnapshot: vi
            .fn()
            .mockResolvedValueOnce(snapshot)
            .mockResolvedValueOnce({ ...snapshot, liquidity: 0n }) as any,
          executeOnce: executeOnce as any,
          fetchReceiptByPda: vi
            .fn()
            .mockResolvedValueOnce(null)
            .mockImplementationOnce(async () => ({
              authority,
              positionMint: snapshot.positionMint,
              epoch,
              direction: 0,
              attestationHash,
              slot: BigInt(1),
              unixTs: BigInt(1),
              bump: 255,
            })) as any,
          nowMs: () => nowMs,
        }),
      ),
    ).resolves.toBeUndefined();

    expect(executeOnce).toHaveBeenCalledTimes(2);
    await cleanup();
  });

});
