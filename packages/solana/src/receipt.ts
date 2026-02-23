import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountInfo,
  type AccountMeta,
  type Connection,
} from '@solana/web3.js';

type Direction = 0 | 1;

export const RECEIPT_PROGRAM_ID = new PublicKey('A81Xsuwg5zrT1sgvkncemfWqQ8nymwHS3e7ExM4YnXMm');

export function deriveReceiptPda(params: {
  authority: PublicKey;
  positionMint: PublicKey;
  epoch: number;
  programId?: PublicKey;
}): [PublicKey, number] {
  const epochLe = Buffer.alloc(4);
  epochLe.writeUInt32LE(params.epoch);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('receipt'), params.authority.toBuffer(), params.positionMint.toBuffer(), epochLe],
    params.programId ?? RECEIPT_PROGRAM_ID,
  );
}

function u32Le(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value);
  return b;
}

// Anchor discriminator for `record_execution` (must match target/idl/receipt.json)
const RECORD_EXECUTION_DISCRIMINATOR = Buffer.from([231, 245, 144, 129, 178, 195, 89, 160]);

export type ReceiptAccount = {
  authority: PublicKey;
  positionMint: PublicKey;
  epoch: number;
  direction: number;
  attestationHash: Uint8Array;
  slot: bigint;
  unixTs: bigint;
  bump: number;
};

function decodeReceipt(info: AccountInfo<Buffer>): ReceiptAccount {
  const data = info.data;
  if (data.length < 126) {
    throw new Error('receipt account too small');
  }

  return {
    authority: new PublicKey(data.subarray(8, 40)),
    positionMint: new PublicKey(data.subarray(40, 72)),
    epoch: data.readUInt32LE(72),
    direction: data.readUInt8(76),
    attestationHash: data.subarray(77, 109),
    slot: data.readBigUInt64LE(109),
    unixTs: data.readBigInt64LE(117),
    bump: data.readUInt8(125),
  };
}

export async function fetchReceiptByPda(
  connection: Pick<Connection, 'getAccountInfo'>,
  receiptPda: PublicKey,
): Promise<ReceiptAccount | null> {
  const info = await connection.getAccountInfo(receiptPda, 'confirmed');
  if (!info) return null;
  return decodeReceipt(info as AccountInfo<Buffer>);
}

export function buildRecordExecutionIx(params: {
  authority: PublicKey;
  positionMint: PublicKey;
  epoch: number;
  direction: Direction;
  attestationHash: Uint8Array;
  programId?: PublicKey;
}): TransactionInstruction {
  if (params.attestationHash.length !== 32) {
    throw new Error('attestationHash must be 32 bytes');
  }

  const programId = params.programId ?? RECEIPT_PROGRAM_ID;
  const [receiptPda] = deriveReceiptPda({
    authority: params.authority,
    positionMint: params.positionMint,
    epoch: params.epoch,
    programId,
  });

  const data = Buffer.concat([
    RECORD_EXECUTION_DISCRIMINATOR,
    u32Le(params.epoch),
    Buffer.from([params.direction]),
    params.positionMint.toBuffer(),
    Buffer.from(params.attestationHash),
  ]);

  const keys: AccountMeta[] = [
    { pubkey: params.authority, isSigner: true, isWritable: true },
    { pubkey: receiptPda, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ programId, keys, data });
}
