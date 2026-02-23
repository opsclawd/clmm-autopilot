import { PublicKey, TransactionInstruction, type AccountMeta } from '@solana/web3.js';
import type { PositionSnapshot } from './orcaInspector';
import { buildCreateAtaIdempotentIx, getAta } from './ata';

export const ORCA_WHIRLPOOL_PROGRAM_ID = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

// Whirlpool IDL discriminators (v2 instructions) for deterministic TS-side construction.
const DISCRIMINATOR_DECREASE_LIQUIDITY_V2 = Buffer.from([58, 127, 188, 62, 79, 82, 196, 96]);
const DISCRIMINATOR_COLLECT_FEES_V2 = Buffer.from([207, 117, 95, 191, 229, 180, 226, 15]);

function writeU64LE(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}

function writeU128LE(v: bigint): Buffer {
  const b = Buffer.alloc(16);
  const lo = BigInt.asUintN(64, v);
  const hi = v >> BigInt(64);
  b.writeBigUInt64LE(lo, 0);
  b.writeBigUInt64LE(hi, 8);
  return b;
}

export type OrcaExitIxs = {
  conditionalAtaIxs: TransactionInstruction[];
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
  const positionTokenAccount = getAta(params.snapshot.positionMint, params.authority);
  const ownerA = getAta(params.snapshot.tokenMintA, params.authority, params.snapshot.tokenProgramA);
  const ownerB = getAta(params.snapshot.tokenMintB, params.authority, params.snapshot.tokenProgramB);

  const conditionalAtaIxs: TransactionInstruction[] = [
    buildCreateAtaIdempotentIx({ payer: params.payer, owner: params.authority, mint: params.snapshot.positionMint }).ix,
    buildCreateAtaIdempotentIx({ payer: params.payer, owner: params.authority, mint: params.snapshot.tokenMintA, tokenProgramId: params.snapshot.tokenProgramA }).ix,
    buildCreateAtaIdempotentIx({ payer: params.payer, owner: params.authority, mint: params.snapshot.tokenMintB, tokenProgramId: params.snapshot.tokenProgramB }).ix,
  ];

  const removeKeys: AccountMeta[] = [
    { pubkey: params.snapshot.whirlpool, isSigner: false, isWritable: true },
    { pubkey: params.snapshot.tokenProgramA, isSigner: false, isWritable: false },
    { pubkey: params.snapshot.tokenProgramB, isSigner: false, isWritable: false },
    { pubkey: MEMO_PROGRAM_ID, isSigner: false, isWritable: false },
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
  ];

  const liquidityAmount = params.snapshot.liquidity;
  const data = Buffer.concat([
    DISCRIMINATOR_DECREASE_LIQUIDITY_V2,
    writeU128LE(liquidityAmount),
    writeU64LE(BigInt(0)),
    writeU64LE(BigInt(0)),
    Buffer.from([0]), // Option<RemainingAccountsInfo> = None
  ]);

  const removeLiquidityIx = new TransactionInstruction({ programId: ORCA_WHIRLPOOL_PROGRAM_ID, keys: removeKeys, data });

  const collectKeys: AccountMeta[] = [
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
    { pubkey: MEMO_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  const collectFeesIx = new TransactionInstruction({
    programId: ORCA_WHIRLPOOL_PROGRAM_ID,
    keys: collectKeys,
    data: Buffer.concat([DISCRIMINATOR_COLLECT_FEES_V2, Buffer.from([0])]), // RemainingAccountsInfo = None
  });

  return {
    conditionalAtaIxs,
    removeLiquidityIx,
    collectFeesIx,
    tokenOwnerAccountA: ownerA,
    tokenOwnerAccountB: ownerB,
    positionTokenAccount,
  };
}
