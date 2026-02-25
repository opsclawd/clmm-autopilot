import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';

vi.mock('../orca/decode', () => ({
  decodePositionAccount: (data: Buffer) => ({
    whirlpool: new PublicKey(data.subarray(8, 40)),
    positionMint: new PublicKey(data.subarray(40, 72)),
    liquidity: {
      toString: () => {
        const lo = data.readBigUInt64LE(72);
        const hi = data.readBigUInt64LE(80);
        return (lo + (hi << 64n)).toString();
      },
    },
    tickLowerIndex: data.readInt32LE(88),
    tickUpperIndex: data.readInt32LE(92),
  }),
  decodeWhirlpoolAccount: (data: Buffer) => ({
    tickSpacing: data.readUInt16LE(41),
    tickCurrentIndex: data.readInt32LE(85),
    tokenMintA: new PublicKey(data.subarray(101, 133)),
    tokenVaultA: new PublicKey(data.subarray(133, 165)),
    tokenMintB: new PublicKey(data.subarray(181, 213)),
    tokenVaultB: new PublicKey(data.subarray(213, 245)),
  }),
}));

import * as orcaDecode from '../orca/decode';
import {
  __setRemovePreviewQuoteFnForTests,
  clearTickArrayCache,
  loadPositionSnapshot,
} from '../orcaInspector';

const TOKEN_PROGRAM_V1 = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_PROGRAM_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkA6Ww2c47QhN7f6vYfP2D4W3');
const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const USDC_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

function mkPositionData(args: {
  whirlpool: PublicKey;
  positionMint: PublicKey;
  liquidity: bigint;
  lowerTickIndex: number;
  upperTickIndex: number;
}): Buffer {
  const b = Buffer.alloc(128);
  args.whirlpool.toBuffer().copy(b, 8);
  args.positionMint.toBuffer().copy(b, 40);
  b.writeBigUInt64LE(args.liquidity & ((1n << 64n) - 1n), 72);
  b.writeBigUInt64LE(args.liquidity >> 64n, 80);
  b.writeInt32LE(args.lowerTickIndex, 88);
  b.writeInt32LE(args.upperTickIndex, 92);
  return b;
}

function mkWhirlpoolData(args: {
  tickSpacing: number;
  currentTickIndex: number;
  tokenMintA: PublicKey;
  tokenVaultA: PublicKey;
  tokenMintB: PublicKey;
  tokenVaultB: PublicKey;
}): Buffer {
  const b = Buffer.alloc(245);
  b.writeUInt16LE(args.tickSpacing, 41);
  b.writeInt32LE(args.currentTickIndex, 85);
  args.tokenMintA.toBuffer().copy(b, 101);
  args.tokenVaultA.toBuffer().copy(b, 133);
  args.tokenMintB.toBuffer().copy(b, 181);
  args.tokenVaultB.toBuffer().copy(b, 213);
  return b;
}

function mkMintData(decimals: number): Buffer {
  const b = Buffer.alloc(82);
  b.writeUInt8(decimals, 44);
  return b;
}

function mockConn(state: {
  slot?: number;
  accounts: Map<string, { data: Buffer; owner?: PublicKey }>;
}) {
  return {
    getSlot: async () => state.slot ?? 500,
    getAccountInfo: async (pubkey: PublicKey) => {
      const a = state.accounts.get(pubkey.toBase58());
      if (!a) return null;
      return {
        data: a.data,
        executable: false,
        lamports: 1,
        owner: a.owner ?? TOKEN_PROGRAM_V1,
        rentEpoch: 0,
      };
    },
  } as never;
}

describe('loadPositionSnapshot', () => {
  afterEach(() => {
    __setRemovePreviewQuoteFnForTests(undefined);
  });
  it('loads deterministic fixture snapshot with required addresses', async () => {
    clearTickArrayCache();
    __setRemovePreviewQuoteFnForTests(
      () => ({ tokenEstA: { toString: () => '123' }, tokenEstB: { toString: () => '456' } }) as never,
    );
    const position = Keypair.generate().publicKey;
    const whirlpool = Keypair.generate().publicKey;
    const positionMint = Keypair.generate().publicKey;
    const tokenMintA = SOL_MINT;
    const tokenMintB = USDC_MINT;
    const tokenVaultA = Keypair.generate().publicKey;
    const tokenVaultB = Keypair.generate().publicKey;

    const accounts = new Map<string, { data: Buffer; owner?: PublicKey }>();
    accounts.set(
      position.toBase58(),
      { data: mkPositionData({ whirlpool, positionMint, liquidity: 1234n, lowerTickIndex: 120, upperTickIndex: 200 }) },
    );
    accounts.set(
      whirlpool.toBase58(),
      {
        data: mkWhirlpoolData({
          tickSpacing: 1,
          currentTickIndex: 150,
          tokenMintA,
          tokenVaultA,
          tokenMintB,
          tokenVaultB,
        }),
      },
    );
    accounts.set(tokenMintA.toBase58(), { data: mkMintData(6), owner: TOKEN_PROGRAM_V1 });
    accounts.set(tokenMintB.toBase58(), { data: mkMintData(9), owner: TOKEN_PROGRAM_2022 });

    const snapshot = await loadPositionSnapshot(mockConn({ accounts }), position);

    expect(snapshot.position.toBase58()).toBe(position.toBase58());
    expect(snapshot.whirlpool.toBase58()).toBe(whirlpool.toBase58());
    expect(snapshot.positionMint.toBase58()).toBe(positionMint.toBase58());
    expect(snapshot.currentTickIndex).toBe(150);
    expect(snapshot.lowerTickIndex).toBe(120);
    expect(snapshot.upperTickIndex).toBe(200);
    expect(snapshot.inRange).toBe(true);
    expect(snapshot.tokenVaultA.toBase58()).toBe(tokenVaultA.toBase58());
    expect(snapshot.tokenVaultB.toBase58()).toBe(tokenVaultB.toBase58());
    expect(snapshot.tokenProgramA.toBase58()).toBe(TOKEN_PROGRAM_V1.toBase58());
    expect(snapshot.tokenProgramB.toBase58()).toBe(TOKEN_PROGRAM_2022.toBase58());
    expect(snapshot.pairLabel).toBe('SOL/USDC');
    expect(snapshot.pairValid).toBe(true);
    expect(snapshot.removePreview).toEqual({ tokenAOut: 123n, tokenBOut: 456n });
    expect(snapshot.removePreviewReasonCode).toBeNull();
  });

  it('uses tick-only comparisons for inRange', async () => {
    clearTickArrayCache();
    const position = Keypair.generate().publicKey;
    const whirlpool = Keypair.generate().publicKey;
    const positionMint = Keypair.generate().publicKey;
    const tokenMintA = SOL_MINT;
    const tokenMintB = USDC_MINT;

    const accounts = new Map<string, { data: Buffer; owner?: PublicKey }>();
    accounts.set(
      position.toBase58(),
      { data: mkPositionData({ whirlpool, positionMint, liquidity: 1n, lowerTickIndex: 120, upperTickIndex: 200 }) },
    );
    accounts.set(
      whirlpool.toBase58(),
      {
        data: mkWhirlpoolData({
          tickSpacing: 1,
          currentTickIndex: 201,
          tokenMintA,
          tokenVaultA: Keypair.generate().publicKey,
          tokenMintB,
          tokenVaultB: Keypair.generate().publicKey,
        }),
      },
    );
    accounts.set(tokenMintA.toBase58(), { data: mkMintData(6), owner: TOKEN_PROGRAM_V1 });
    accounts.set(tokenMintB.toBase58(), { data: mkMintData(9), owner: TOKEN_PROGRAM_V1 });

    const snapshot = await loadPositionSnapshot(mockConn({ accounts }), position);
    expect(snapshot.inRange).toBe(false);
  });

  it('quote failure returns null preview + QUOTE_UNAVAILABLE', async () => {
    clearTickArrayCache();
    __setRemovePreviewQuoteFnForTests(() => {
      throw new Error('quote failed');
    });

    const position = Keypair.generate().publicKey;
    const whirlpool = Keypair.generate().publicKey;
    const positionMint = Keypair.generate().publicKey;
    const tokenMintA = SOL_MINT;
    const tokenMintB = USDC_MINT;

    const accounts = new Map<string, { data: Buffer; owner?: PublicKey }>();
    accounts.set(
      position.toBase58(),
      { data: mkPositionData({ whirlpool, positionMint, liquidity: 1n, lowerTickIndex: 120, upperTickIndex: 200 }) },
    );
    accounts.set(
      whirlpool.toBase58(),
      {
        data: mkWhirlpoolData({
          tickSpacing: 1,
          currentTickIndex: 150,
          tokenMintA,
          tokenVaultA: Keypair.generate().publicKey,
          tokenMintB,
          tokenVaultB: Keypair.generate().publicKey,
        }),
      },
    );
    accounts.set(tokenMintA.toBase58(), { data: mkMintData(6), owner: TOKEN_PROGRAM_V1 });
    accounts.set(tokenMintB.toBase58(), { data: mkMintData(9), owner: TOKEN_PROGRAM_V1 });

    const snapshot = await loadPositionSnapshot(mockConn({ accounts }), position);
    expect(snapshot.removePreview).toBeNull();
    expect(snapshot.removePreviewReasonCode).toBe('QUOTE_UNAVAILABLE');
  });

  it('returns NOT_SOL_USDC for non-SOL/USDC pools', async () => {
    clearTickArrayCache();
    const position = Keypair.generate().publicKey;
    const whirlpool = Keypair.generate().publicKey;
    const positionMint = Keypair.generate().publicKey;
    const tokenMintA = Keypair.generate().publicKey;
    const tokenMintB = Keypair.generate().publicKey;

    const accounts = new Map<string, { data: Buffer; owner?: PublicKey }>();
    accounts.set(
      position.toBase58(),
      { data: mkPositionData({ whirlpool, positionMint, liquidity: 1n, lowerTickIndex: 120, upperTickIndex: 200 }) },
    );
    accounts.set(
      whirlpool.toBase58(),
      {
        data: mkWhirlpoolData({
          tickSpacing: 1,
          currentTickIndex: 150,
          tokenMintA,
          tokenVaultA: Keypair.generate().publicKey,
          tokenMintB,
          tokenVaultB: Keypair.generate().publicKey,
        }),
      },
    );
    accounts.set(tokenMintA.toBase58(), { data: mkMintData(6), owner: TOKEN_PROGRAM_V1 });
    accounts.set(tokenMintB.toBase58(), { data: mkMintData(9), owner: TOKEN_PROGRAM_V1 });

    await expect(loadPositionSnapshot(mockConn({ accounts }), position)).rejects.toMatchObject({ code: 'NOT_SOL_USDC' });
  });

  it('returns normalized typed error when position is missing', async () => {
    clearTickArrayCache();
    const position = Keypair.generate().publicKey;
    await expect(loadPositionSnapshot(mockConn({ accounts: new Map() }), position)).rejects.toMatchObject({
      code: 'INVALID_POSITION',
    });
  });

  it('honors explicit cluster override for pair validation', async () => {
    clearTickArrayCache();
    const position = Keypair.generate().publicKey;
    const whirlpool = Keypair.generate().publicKey;
    const positionMint = Keypair.generate().publicKey;

    const accounts = new Map<string, { data: Buffer; owner?: PublicKey }>();
    accounts.set(
      position.toBase58(),
      { data: mkPositionData({ whirlpool, positionMint, liquidity: 1n, lowerTickIndex: 120, upperTickIndex: 200 }) },
    );
    accounts.set(
      whirlpool.toBase58(),
      {
        data: mkWhirlpoolData({
          tickSpacing: 1,
          currentTickIndex: 150,
          tokenMintA: SOL_MINT,
          tokenVaultA: Keypair.generate().publicKey,
          tokenMintB: USDC_MINT,
          tokenVaultB: Keypair.generate().publicKey,
        }),
      },
    );
    accounts.set(SOL_MINT.toBase58(), { data: mkMintData(9), owner: TOKEN_PROGRAM_V1 });
    accounts.set(USDC_MINT.toBase58(), { data: mkMintData(6), owner: TOKEN_PROGRAM_V1 });

    await expect(loadPositionSnapshot(mockConn({ accounts }), position, 'mainnet-beta')).rejects.toMatchObject({
      code: 'NOT_SOL_USDC',
    });
  });

  it('explicitly invalidates tick-array cache when slot changes', async () => {
    clearTickArrayCache();
    __setRemovePreviewQuoteFnForTests(() => {
      throw new Error('quote failed');
    });

    const position = Keypair.generate().publicKey;
    const whirlpool = Keypair.generate().publicKey;
    const positionMint = Keypair.generate().publicKey;
    const tokenMintA = SOL_MINT;
    const tokenMintB = USDC_MINT;

    const accounts = new Map<string, { data: Buffer; owner?: PublicKey }>();
    accounts.set(
      position.toBase58(),
      { data: mkPositionData({ whirlpool, positionMint, liquidity: 1234n, lowerTickIndex: 120, upperTickIndex: 200 }) },
    );
    accounts.set(
      whirlpool.toBase58(),
      {
        data: mkWhirlpoolData({
          tickSpacing: 1,
          currentTickIndex: 150,
          tokenMintA,
          tokenVaultA: Keypair.generate().publicKey,
          tokenMintB,
          tokenVaultB: Keypair.generate().publicKey,
        }),
      },
    );
    accounts.set(tokenMintA.toBase58(), { data: mkMintData(6), owner: TOKEN_PROGRAM_V1 });
    accounts.set(tokenMintB.toBase58(), { data: mkMintData(9), owner: TOKEN_PROGRAM_V1 });

    let slot = 500;
    let tickArrayFetches = 0;
    const conn = {
      getSlot: async () => slot,
      getAccountInfo: async (pubkey: PublicKey) => {
        const a = accounts.get(pubkey.toBase58());
        if (a) {
          return {
            data: a.data,
            executable: false,
            lamports: 1,
            owner: a.owner ?? TOKEN_PROGRAM_V1,
            rentEpoch: 0,
          };
        }
        tickArrayFetches += 1;
        return {
          data: Buffer.alloc(8),
          executable: false,
          lamports: 1,
          owner: TOKEN_PROGRAM_V1,
          rentEpoch: 0,
        };
      },
    } as never;

    await loadPositionSnapshot(conn, position);
    expect(tickArrayFetches).toBe(2);

    await loadPositionSnapshot(conn, position);
    expect(tickArrayFetches).toBe(2);

    slot = 501;
    await loadPositionSnapshot(conn, position);
    expect(tickArrayFetches).toBe(4);
  });

  it('returns DATA_UNAVAILABLE when mint metadata is missing', async () => {
    clearTickArrayCache();
    const position = Keypair.generate().publicKey;
    const whirlpool = Keypair.generate().publicKey;
    const positionMint = Keypair.generate().publicKey;
    const tokenMintA = SOL_MINT;
    const tokenMintB = USDC_MINT;

    const accounts = new Map<string, { data: Buffer; owner?: PublicKey }>();
    accounts.set(
      position.toBase58(),
      { data: mkPositionData({ whirlpool, positionMint, liquidity: 1n, lowerTickIndex: 120, upperTickIndex: 200 }) },
    );
    accounts.set(
      whirlpool.toBase58(),
      {
        data: mkWhirlpoolData({
          tickSpacing: 1,
          currentTickIndex: 150,
          tokenMintA,
          tokenVaultA: Keypair.generate().publicKey,
          tokenMintB,
          tokenVaultB: Keypair.generate().publicKey,
        }),
      },
    );
    accounts.set(tokenMintA.toBase58(), { data: mkMintData(6), owner: TOKEN_PROGRAM_V1 });
    // tokenMintB intentionally missing

    await expect(loadPositionSnapshot(mockConn({ accounts }), position)).rejects.toMatchObject({
      code: 'DATA_UNAVAILABLE',
    });
  });

  it('propagates ORCA_DECODE_FAILED when decoder fails', async () => {
    clearTickArrayCache();
    const position = Keypair.generate().publicKey;
    const accounts = new Map<string, { data: Buffer; owner?: PublicKey }>();
    accounts.set(position.toBase58(), { data: Buffer.alloc(16) });

    const spy = vi.spyOn(orcaDecode, 'decodePositionAccount').mockImplementationOnce(() => {
      throw { code: 'ORCA_DECODE_FAILED', message: 'bad position bytes', retryable: false };
    });

    await expect(loadPositionSnapshot(mockConn({ accounts }), position)).rejects.toMatchObject({
      code: 'ORCA_DECODE_FAILED',
    });

    spy.mockRestore();
  });

  it('inspector delegates Orca account decode to orca/decode module', () => {
    const src = readFileSync(resolve(__dirname, '..', 'orcaInspector.ts'), 'utf8');
    expect(src).toContain("from './orca/decode'");
    expect(src).not.toMatch(/readUInt16LE|readInt32LE|readBigUInt64LE|subarray\(\d+, \d+\)/);
  });
});
