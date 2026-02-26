import { BN } from 'bn.js';
import { assertSolUsdcPair, getCanonicalPairLabel, type SolanaCluster } from '@clmm-autopilot/core';
import { Percentage } from '@orca-so/common-sdk';
import {
  decreaseLiquidityQuoteByLiquidityWithParams,
  NO_TOKEN_EXTENSION_CONTEXT,
  PDAUtil,
  ParsablePosition,
  ParsableWhirlpool,
  PriceMath,
} from '@orca-so/whirlpools-sdk';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';
import { normalizeSolanaError } from './errors';
import { loadSolanaConfig } from './config';
import type { CanonicalErrorCode, NormalizedError } from './types';

const ORCA_WHIRLPOOL_PROGRAM_ID = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const TOKEN_PROGRAM_V1 = TOKEN_PROGRAM_ID;
const TOKEN_PROGRAM_2022 = TOKEN_2022_PROGRAM_ID;

export type RemovePreviewReasonCode = 'QUOTE_UNAVAILABLE' | 'DATA_UNAVAILABLE';

export type RemovePreview = {
  tokenAOut: bigint;
  tokenBOut: bigint;
};

export type PositionSnapshot = {
  cluster: SolanaCluster;
  pairLabel: string;
  pairValid: boolean;
  whirlpool: PublicKey;
  position: PublicKey;
  positionMint: PublicKey;
  positionTokenProgram?: PublicKey;
  currentTickIndex: number;
  lowerTickIndex: number;
  upperTickIndex: number;
  tickSpacing: number;
  inRange: boolean;
  liquidity: bigint;
  tokenMintA: PublicKey;
  tokenMintB: PublicKey;
  tokenDecimalsA: number;
  tokenDecimalsB: number;
  tokenVaultA: PublicKey;
  tokenVaultB: PublicKey;
  tickArrayLower: PublicKey;
  tickArrayUpper: PublicKey;
  tokenProgramA: PublicKey;
  tokenProgramB: PublicKey;
  removePreview: RemovePreview | null;
  removePreviewReasonCode: RemovePreviewReasonCode | null;
};

type ParsedPosition = {
  whirlpool: PublicKey;
  positionMint: PublicKey;
  liquidity: bigint;
  lowerTickIndex: number;
  upperTickIndex: number;
};

type ParsedWhirlpool = {
  tickSpacing: number;
  currentTickIndex: number;
  tokenMintA: PublicKey;
  tokenMintB: PublicKey;
  tokenVaultA: PublicKey;
  tokenVaultB: PublicKey;
};

type MintMeta = {
  decimals: number;
  owner: PublicKey;
};

type CacheEntry = {
  slot: number;
  info: AccountInfo<Buffer> | null;
};

const tickArrayCache = new Map<string, CacheEntry>();
let cacheSlot: number | null = null;
let removePreviewQuoteFn = decreaseLiquidityQuoteByLiquidityWithParams;

export function __setRemovePreviewQuoteFnForTests(
  fn: typeof decreaseLiquidityQuoteByLiquidityWithParams | undefined,
): void {
  removePreviewQuoteFn = fn ?? decreaseLiquidityQuoteByLiquidityWithParams;
}

export function clearTickArrayCache(): void {
  tickArrayCache.clear();
  cacheSlot = null;
}

function makeError(code: CanonicalErrorCode, message: string, retryable = false): NormalizedError {
  return { code, message, retryable };
}

function readPubkey(data: Buffer, offset: number): PublicKey {
  return new PublicKey(data.subarray(offset, offset + 32));
}

function readU16LE(data: Buffer, offset: number): number {
  return data.readUInt16LE(offset);
}

function readI32LE(data: Buffer, offset: number): number {
  return data.readInt32LE(offset);
}

function readU64LE(data: Buffer, offset: number): bigint {
  return data.readBigUInt64LE(offset);
}

function readU128LE(data: Buffer, offset: number): bigint {
  const lo = data.readBigUInt64LE(offset);
  const hi = data.readBigUInt64LE(offset + 8);
  return lo + (hi << BigInt(64));
}

// Fixture-friendly decoding for deterministic tests. Offsets mirror expected Orca account fields.
function parsePositionAccount(data: Buffer): ParsedPosition {
  if (data.length < 128) throw makeError('INVALID_POSITION', 'position account too small');
  return {
    whirlpool: readPubkey(data, 8),
    positionMint: readPubkey(data, 40),
    liquidity: readU128LE(data, 72),
    lowerTickIndex: readI32LE(data, 88),
    upperTickIndex: readI32LE(data, 92),
  };
}

function parsePositionAccountFromInfo(
  address: PublicKey,
  info: AccountInfo<Buffer>,
): ParsedPosition {
  const parsed = ParsablePosition.parse(address, info);
  if (parsed) {
    return {
      whirlpool: parsed.whirlpool,
      positionMint: parsed.positionMint,
      liquidity: BigInt(parsed.liquidity.toString()),
      lowerTickIndex: parsed.tickLowerIndex,
      upperTickIndex: parsed.tickUpperIndex,
    };
  }
  return parsePositionAccount(info.data);
}

function parseWhirlpoolAccount(data: Buffer): ParsedWhirlpool {
  if (data.length < 220) throw makeError('DATA_UNAVAILABLE', 'whirlpool account too small');
  return {
    tickSpacing: readU16LE(data, 41),
    currentTickIndex: readI32LE(data, 85),
    tokenMintA: readPubkey(data, 101),
    tokenVaultA: readPubkey(data, 133),
    tokenMintB: readPubkey(data, 181),
    tokenVaultB: readPubkey(data, 213),
  };
}

function parseWhirlpoolAccountFromInfo(
  address: PublicKey,
  info: AccountInfo<Buffer>,
): ParsedWhirlpool {
  const parsed = ParsableWhirlpool.parse(address, info);
  if (parsed) {
    return {
      tickSpacing: parsed.tickSpacing,
      currentTickIndex: parsed.tickCurrentIndex,
      tokenMintA: parsed.tokenMintA,
      tokenMintB: parsed.tokenMintB,
      tokenVaultA: parsed.tokenVaultA,
      tokenVaultB: parsed.tokenVaultB,
    };
  }
  return parseWhirlpoolAccount(info.data);
}

function parseMintMeta(info: AccountInfo<Buffer> | null): MintMeta {
  if (!info || info.data.length < 45) throw makeError('DATA_UNAVAILABLE', 'mint account unavailable');
  return {
    decimals: info.data.readUInt8(44),
    owner: info.owner,
  };
}

function tokenProgramForOwner(owner: PublicKey): PublicKey {
  if (owner.equals(TOKEN_PROGRAM_2022)) return TOKEN_PROGRAM_2022;
  return TOKEN_PROGRAM_V1;
}

function deriveTickArrayFromTickIndex(whirlpool: PublicKey, tickIndex: number, tickSpacing: number): PublicKey {
  return PDAUtil.getTickArrayFromTickIndex(
    tickIndex,
    tickSpacing,
    whirlpool,
    ORCA_WHIRLPOOL_PROGRAM_ID,
  ).publicKey;
}

async function getCachedTickArray(
  connection: Pick<Connection, 'getSlot' | 'getAccountInfo'>,
  pubkey: PublicKey,
): Promise<AccountInfo<Buffer> | null> {
  const slot = await connection.getSlot('confirmed');
  if (cacheSlot !== slot) {
    tickArrayCache.clear();
    cacheSlot = slot;
  }

  const key = pubkey.toBase58();
  const cached = tickArrayCache.get(key);
  if (cached) return cached.info;

  const info = await connection.getAccountInfo(pubkey, 'confirmed');
  tickArrayCache.set(key, { slot, info });
  return info;
}

function computeRemovePreview(
  position: ParsedPosition,
  whirlpool: ParsedWhirlpool,
): { preview: RemovePreview | null; reasonCode: RemovePreviewReasonCode | null } {
  try {
    const quote = removePreviewQuoteFn({
      liquidity: new BN(position.liquidity.toString()),
      tickCurrentIndex: whirlpool.currentTickIndex,
      sqrtPrice: PriceMath.tickIndexToSqrtPriceX64(whirlpool.currentTickIndex),
      tickLowerIndex: position.lowerTickIndex,
      tickUpperIndex: position.upperTickIndex,
      tokenExtensionCtx: {
        currentEpoch: NO_TOKEN_EXTENSION_CONTEXT.currentEpoch,
        tokenMintWithProgramA: NO_TOKEN_EXTENSION_CONTEXT.tokenMintWithProgramA,
        tokenMintWithProgramB: NO_TOKEN_EXTENSION_CONTEXT.tokenMintWithProgramB,
      },
      slippageTolerance: Percentage.fromFraction(1, 100),
    });

    return {
      preview: {
        tokenAOut: BigInt(quote.tokenEstA.toString()),
        tokenBOut: BigInt(quote.tokenEstB.toString()),
      },
      reasonCode: null,
    };
  } catch {
    return {
      preview: null,
      reasonCode: 'QUOTE_UNAVAILABLE',
    };
  }
}

export async function loadPositionSnapshot(
  connection: Pick<Connection, 'getAccountInfo' | 'getSlot'>,
  positionPubkey: PublicKey,
  clusterOverride?: SolanaCluster,
): Promise<PositionSnapshot> {
  try {
    const positionInfo = await connection.getAccountInfo(positionPubkey, 'confirmed');
    if (!positionInfo) throw makeError('INVALID_POSITION', 'position account not found');

    const position = parsePositionAccountFromInfo(positionPubkey, positionInfo);

    const whirlpoolInfo = await connection.getAccountInfo(position.whirlpool, 'confirmed');
    if (!whirlpoolInfo) throw makeError('DATA_UNAVAILABLE', 'whirlpool account not found');
    const whirlpool = parseWhirlpoolAccountFromInfo(position.whirlpool, whirlpoolInfo);

    const cluster = clusterOverride ?? loadSolanaConfig(process.env).cluster;
    assertSolUsdcPair(whirlpool.tokenMintA.toBase58(), whirlpool.tokenMintB.toBase58(), cluster);

    const [positionMintInfo, mintAInfo, mintBInfo] = await Promise.all([
      connection.getAccountInfo(position.positionMint, 'confirmed'),
      connection.getAccountInfo(whirlpool.tokenMintA, 'confirmed'),
      connection.getAccountInfo(whirlpool.tokenMintB, 'confirmed'),
    ]);
    const positionMintMeta = parseMintMeta(positionMintInfo);
    const mintA = parseMintMeta(mintAInfo);
    const mintB = parseMintMeta(mintBInfo);
    const pairLabel = getCanonicalPairLabel(cluster);

    const tickArrayLower = deriveTickArrayFromTickIndex(
      position.whirlpool,
      position.lowerTickIndex,
      whirlpool.tickSpacing,
    );
    const tickArrayUpper = deriveTickArrayFromTickIndex(
      position.whirlpool,
      position.upperTickIndex,
      whirlpool.tickSpacing,
    );

    await Promise.all([
      getCachedTickArray(connection, tickArrayLower),
      getCachedTickArray(connection, tickArrayUpper),
    ]);

    const removePreviewResult = computeRemovePreview(position, whirlpool);

    return {
      cluster,
      pairLabel,
      pairValid: true,
      whirlpool: position.whirlpool,
      position: positionPubkey,
      positionMint: position.positionMint,
      positionTokenProgram: tokenProgramForOwner(positionMintMeta.owner),
      currentTickIndex: whirlpool.currentTickIndex,
      lowerTickIndex: position.lowerTickIndex,
      upperTickIndex: position.upperTickIndex,
      tickSpacing: whirlpool.tickSpacing,
      inRange:
        whirlpool.currentTickIndex >= position.lowerTickIndex &&
        whirlpool.currentTickIndex <= position.upperTickIndex,
      liquidity: position.liquidity,
      tokenMintA: whirlpool.tokenMintA,
      tokenMintB: whirlpool.tokenMintB,
      tokenDecimalsA: mintA.decimals,
      tokenDecimalsB: mintB.decimals,
      tokenVaultA: whirlpool.tokenVaultA,
      tokenVaultB: whirlpool.tokenVaultB,
      tickArrayLower,
      tickArrayUpper,
      tokenProgramA: tokenProgramForOwner(mintA.owner),
      tokenProgramB: tokenProgramForOwner(mintB.owner),
      removePreview: removePreviewResult.preview,
      removePreviewReasonCode: removePreviewResult.reasonCode,
    };
  } catch (error) {
    if (
      typeof error === 'object' &&
      error &&
      'code' in error &&
      'message' in error &&
      'retryable' in error
    ) {
      throw error;
    }
    throw normalizeSolanaError(error);
  }
}
