import { afterEach, describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDevnetE2E } from '../e2eDevnet';

const SOL = new PublicKey('So11111111111111111111111111111111111111112');
const USDC = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const NOT_USDC = new PublicKey('Es9vMFrzaCERmJfrF4H2FYD8fYF8f3L7hPwrKyYVJZZW');

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
      runDevnetE2E(env, () => {}, {
        loadPositionSnapshot: vi.fn(async () => mockSnapshot(env.POSITION_ADDRESS, {
          tokenMintB: NOT_USDC,
          pairLabel: 'SOL/USDT',
        })) as any,
        fetchJupiterQuote: vi.fn() as any,
        executeOnce: executeOnce as any,
        fetchReceiptByPda: vi.fn() as any,
        getSlot: vi.fn(async () => 123),
        nowMs: () => 1_700_000_000_000,
      }),
    ).rejects.toMatchObject({ code: 'NOT_SOL_USDC' });

    expect(executeOnce).not.toHaveBeenCalled();
    await cleanup();
  });

  it('refuses with ALREADY_EXECUTED_THIS_EPOCH before executeOnce', async () => {
    const { env, cleanup } = await makeEnv();
    const executeOnce = vi.fn();

    await expect(
      runDevnetE2E(env, () => {}, {
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
      }),
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

  it('returns INVALID_KEYPAIR when keypair JSON is malformed', async () => {
    const { env, cleanup } = await makeEnv('{not valid json');

    await expect(runDevnetE2E(env, () => {})).rejects.toMatchObject({ code: 'INVALID_KEYPAIR' });
    await cleanup();
  });
});
