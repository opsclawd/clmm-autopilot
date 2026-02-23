import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  clearTickArrayCache,
  loadPositionSnapshot,
} from '../orcaInspector';

const TOKEN_PROGRAM_V1 = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_PROGRAM_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkA6Ww2c47QhN7f6vYfP2D4W3');

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
  it('loads deterministic fixture snapshot with required addresses', async () => {
    clearTickArrayCache();
    const position = Keypair.generate().publicKey;
    const whirlpool = Keypair.generate().publicKey;
    const positionMint = Keypair.generate().publicKey;
    const tokenMintA = Keypair.generate().publicKey;
    const tokenMintB = Keypair.generate().publicKey;
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
    expect(snapshot.currentTickIndex).toBe(150);
    expect(snapshot.lowerTickIndex).toBe(120);
    expect(snapshot.upperTickIndex).toBe(200);
    expect(snapshot.inRange).toBe(true);
    expect(snapshot.tokenVaultA.toBase58()).toBe(tokenVaultA.toBase58());
    expect(snapshot.tokenVaultB.toBase58()).toBe(tokenVaultB.toBase58());
    expect(snapshot.tokenProgramA.toBase58()).toBe(TOKEN_PROGRAM_V1.toBase58());
    expect(snapshot.tokenProgramB.toBase58()).toBe(TOKEN_PROGRAM_2022.toBase58());
    expect(snapshot.removePreview).toBeNull();
    expect(snapshot.removePreviewReasonCode).toBe('QUOTE_UNAVAILABLE');
  });

  it('uses tick-only comparisons for inRange', async () => {
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

  it('returns normalized typed error when position is missing', async () => {
    clearTickArrayCache();
    const position = Keypair.generate().publicKey;
    await expect(loadPositionSnapshot(mockConn({ accounts: new Map() }), position)).rejects.toMatchObject({
      code: 'INVALID_POSITION',
    });
  });

  it('returns DATA_UNAVAILABLE when mint metadata is missing', async () => {
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
    // tokenMintB intentionally missing

    await expect(loadPositionSnapshot(mockConn({ accounts }), position)).rejects.toMatchObject({
      code: 'DATA_UNAVAILABLE',
    });
  });
});
