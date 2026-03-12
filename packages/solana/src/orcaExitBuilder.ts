import { PublicKey, TransactionInstruction, type AccountMeta } from '@solana/web3.js';
import type { PositionSnapshot } from './orcaInspector';
import { getAta } from './ata';
import { MEMO_PROGRAM_ID, TOKEN_PROGRAM_ID } from './token/constants';
import {
  INCLUDE_MEMO_ON_V2,
  buildTokenContext,
  selectWhirlpoolInstructionVariant,
  type WhirlpoolInstructionVariant,
} from './token/whirlpool';
import type { CanonicalErrorCode } from './types';

export const ORCA_WHIRLPOOL_PROGRAM_ID = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');

// Whirlpool IDL discriminators for deterministic TS-side construction.
const DISCRIMINATOR_DECREASE_LIQUIDITY = Buffer.from([160, 38, 208, 111, 104, 91, 44, 1]);
const DISCRIMINATOR_DECREASE_LIQUIDITY_V2 = Buffer.from([58, 127, 188, 62, 79, 82, 196, 96]);
const DISCRIMINATOR_COLLECT_FEES = Buffer.from([164, 152, 207, 99, 30, 186, 19, 182]);
const DISCRIMINATOR_COLLECT_FEES_V2 = Buffer.from([207, 117, 95, 191, 229, 180, 226, 15]);

type TypedError = Error & { code: CanonicalErrorCode; retryable: boolean; debug?: unknown };

function writeU64LE(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  let n = BigInt.asUintN(64, v);
  for (let i = 0; i < 8; i += 1) {
    b[i] = Number(n & BigInt(0xff));
    n >>= BigInt(8);
  }
  return b;
}

function writeU128LE(v: bigint): Buffer {
  const b = Buffer.alloc(16);
  const lo = BigInt.asUintN(64, v);
  const hi = BigInt.asUintN(64, v >> BigInt(64));
  let n = lo;
  for (let i = 0; i < 8; i += 1) {
    b[i] = Number(n & BigInt(0xff));
    n >>= BigInt(8);
  }
  n = hi;
  for (let i = 0; i < 8; i += 1) {
    b[8 + i] = Number(n & BigInt(0xff));
    n >>= BigInt(8);
  }
  return b;
}

function fail(code: CanonicalErrorCode, message: string, debug?: unknown): never {
  const err = new Error(message) as TypedError;
  err.code = code;
  err.retryable = false;
  if (debug !== undefined) err.debug = debug;
  throw err;
}

export type OrcaExitIxs = {
  variant: WhirlpoolInstructionVariant;
  removeLiquidityIx: TransactionInstruction;
  collectFeesIx: TransactionInstruction;
  tokenOwnerAccountA: PublicKey;
  tokenOwnerAccountB: PublicKey;
  positionTokenAccount: PublicKey;
};

export function buildOrcaExitIxs(params: {
  snapshot: PositionSnapshot;
  authority: PublicKey;
  payer: PublicKey;
}): OrcaExitIxs {
  const positionTokenProgram = params.snapshot.positionTokenProgram;
  if (!positionTokenProgram) {
    fail('DATA_UNAVAILABLE', 'position token program unavailable', {
      positionMint: params.snapshot.positionMint.toBase58(),
      position: params.snapshot.position.toBase58(),
    });
  }

  const positionTokenAccount = getAta(params.snapshot.positionMint, params.authority, positionTokenProgram);
  const ownerA = getAta(params.snapshot.tokenMintA, params.authority, params.snapshot.tokenProgramA);
  const ownerB = getAta(params.snapshot.tokenMintB, params.authority, params.snapshot.tokenProgramB);
  const tokenContext = buildTokenContext({
    mintA: params.snapshot.tokenMintA,
    mintB: params.snapshot.tokenMintB,
    tokenProgramA: params.snapshot.tokenProgramA,
    tokenProgramB: params.snapshot.tokenProgramB,
  });
  const variant = selectWhirlpoolInstructionVariant(tokenContext);

  const removeKeys: AccountMeta[] =
    variant === 'v2'
      ? [
          { pubkey: params.snapshot.whirlpool, isSigner: false, isWritable: true },
          { pubkey: params.snapshot.tokenProgramA, isSigner: false, isWritable: false },
          { pubkey: params.snapshot.tokenProgramB, isSigner: false, isWritable: false },
          ...(INCLUDE_MEMO_ON_V2 ? [{ pubkey: MEMO_PROGRAM_ID, isSigner: false, isWritable: false }] : []),
          { pubkey: params.authority, isSigner: true, isWritable: false },
          { pubkey: params.snapshot.position, isSigner: false, isWritable: true },
          { pubkey: positionTokenAccount, isSigner: false, isWritable: false },
          { pubkey: params.snapshot.tokenMintA, isSigner: false, isWritable: false },
          { pubkey: params.snapshot.tokenMintB, isSigner: false, isWritable: false },
          { pubkey: ownerA, isSigner: false, isWritable: true },
          { pubkey: ownerB, isSigner: false, isWritable: true },
          { pubkey: params.snapshot.tokenVaultA, isSigner: false, isWritable: true },
          { pubkey: params.snapshot.tokenVaultB, isSigner: false, isWritable: true },
          { pubkey: params.snapshot.tickArrayLower, isSigner: false, isWritable: true },
          { pubkey: params.snapshot.tickArrayUpper, isSigner: false, isWritable: true },
        ]
      : [
          { pubkey: params.snapshot.whirlpool, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: params.authority, isSigner: true, isWritable: false },
          { pubkey: params.snapshot.position, isSigner: false, isWritable: true },
          { pubkey: positionTokenAccount, isSigner: false, isWritable: false },
          { pubkey: ownerA, isSigner: false, isWritable: true },
          { pubkey: ownerB, isSigner: false, isWritable: true },
          { pubkey: params.snapshot.tokenVaultA, isSigner: false, isWritable: true },
          { pubkey: params.snapshot.tokenVaultB, isSigner: false, isWritable: true },
          { pubkey: params.snapshot.tickArrayLower, isSigner: false, isWritable: true },
          { pubkey: params.snapshot.tickArrayUpper, isSigner: false, isWritable: true },
        ];

  const liquidityAmount = params.snapshot.liquidity;
  const data =
    variant === 'v2'
      ? Buffer.concat([
          DISCRIMINATOR_DECREASE_LIQUIDITY_V2,
          writeU128LE(liquidityAmount),
          writeU64LE(BigInt(0)),
          writeU64LE(BigInt(0)),
          Buffer.from([0]), // Option<RemainingAccountsInfo> = None
        ])
      : Buffer.concat([
          DISCRIMINATOR_DECREASE_LIQUIDITY,
          writeU128LE(liquidityAmount),
          writeU64LE(BigInt(0)),
          writeU64LE(BigInt(0)),
        ]);

  const removeLiquidityIx = new TransactionInstruction({ programId: ORCA_WHIRLPOOL_PROGRAM_ID, keys: removeKeys, data });

  const collectKeys: AccountMeta[] =
    variant === 'v2'
      ? [
          { pubkey: params.snapshot.whirlpool, isSigner: false, isWritable: false },
          { pubkey: params.authority, isSigner: true, isWritable: false },
          { pubkey: params.snapshot.position, isSigner: false, isWritable: true },
          { pubkey: positionTokenAccount, isSigner: false, isWritable: false },
          { pubkey: params.snapshot.tokenMintA, isSigner: false, isWritable: false },
          { pubkey: params.snapshot.tokenMintB, isSigner: false, isWritable: false },
          { pubkey: ownerA, isSigner: false, isWritable: true },
          { pubkey: params.snapshot.tokenVaultA, isSigner: false, isWritable: true },
          { pubkey: ownerB, isSigner: false, isWritable: true },
          { pubkey: params.snapshot.tokenVaultB, isSigner: false, isWritable: true },
          { pubkey: params.snapshot.tokenProgramA, isSigner: false, isWritable: false },
          { pubkey: params.snapshot.tokenProgramB, isSigner: false, isWritable: false },
          ...(INCLUDE_MEMO_ON_V2 ? [{ pubkey: MEMO_PROGRAM_ID, isSigner: false, isWritable: false }] : []),
        ]
      : [
          { pubkey: params.snapshot.whirlpool, isSigner: false, isWritable: false },
          { pubkey: params.authority, isSigner: true, isWritable: false },
          { pubkey: params.snapshot.position, isSigner: false, isWritable: true },
          { pubkey: positionTokenAccount, isSigner: false, isWritable: false },
          { pubkey: ownerA, isSigner: false, isWritable: true },
          { pubkey: params.snapshot.tokenVaultA, isSigner: false, isWritable: true },
          { pubkey: ownerB, isSigner: false, isWritable: true },
          { pubkey: params.snapshot.tokenVaultB, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ];

  const collectFeesIx = new TransactionInstruction({
    programId: ORCA_WHIRLPOOL_PROGRAM_ID,
    keys: collectKeys,
    data:
      variant === 'v2'
        ? Buffer.concat([DISCRIMINATOR_COLLECT_FEES_V2, Buffer.from([0])]) // RemainingAccountsInfo = None
        : DISCRIMINATOR_COLLECT_FEES,
  });

  return {
    variant,
    removeLiquidityIx,
    collectFeesIx,
    tokenOwnerAccountA: ownerA,
    tokenOwnerAccountB: ownerB,
    positionTokenAccount,
  };
}
