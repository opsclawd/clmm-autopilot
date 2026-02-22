import { PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from '@solana/web3.js';

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

const RECORD_EXECUTION_DISCRIMINATOR = Buffer.from([15, 145, 122, 33, 211, 42, 58, 95]);

export function buildRecordExecutionIx(params: {
  authority: PublicKey;
  positionMint: PublicKey;
  epoch: number;
  direction: Direction;
  txSigHash: Uint8Array;
  programId?: PublicKey;
}): TransactionInstruction {
  if (params.txSigHash.length !== 32) {
    throw new Error('txSigHash must be 32 bytes');
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
    Buffer.from(params.txSigHash),
  ]);

  const keys: AccountMeta[] = [
    { pubkey: params.authority, isSigner: true, isWritable: true },
    { pubkey: receiptPda, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ programId, keys, data });
}
