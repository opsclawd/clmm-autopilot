import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountInfo,
  type AccountMeta,
  type Connection,
} from '@solana/web3.js';
import { loadReceiptIdlArtifact, type ReceiptIdlArg } from './receiptIdentity';
import type { CanonicalErrorCode } from './types';

type Direction = 0 | 1;
const DEFAULT_RECEIPT_IDL_PATH = 'deployments/devnet/receipt.idl.json';

type TypedError = Error & { code: CanonicalErrorCode; retryable: boolean; debug?: unknown };
type RecordExecutionInstructionSpec = {
  discriminator: Buffer;
  args: ReceiptIdlArg[];
  accounts: Array<{ name: string; signer: boolean; writable: boolean; address?: PublicKey }>;
};

const recordExecutionSpecCache = new Map<string, RecordExecutionInstructionSpec>();

function fail(code: CanonicalErrorCode, message: string, debug?: unknown): never {
  const err = new Error(message) as TypedError;
  err.code = code;
  err.retryable = false;
  if (debug !== undefined) err.debug = debug;
  throw err;
}

export type ReceiptAccount = {
  authority: PublicKey;
  positionMint: PublicKey;
  epoch: number;
  direction: number;
  attestationHash: Uint8Array;
  slot: bigint;
  unixTs: bigint;
  initialized: boolean;
  bump: number;
};

export function deriveReceiptPda(params: {
  authority: PublicKey;
  positionMint: PublicKey;
  epoch: number;
  programId: PublicKey;
}): [PublicKey, number] {
  const epochLe = Buffer.alloc(4);
  epochLe.writeUInt32LE(params.epoch);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('receipt'), params.authority.toBuffer(), params.positionMint.toBuffer(), epochLe],
    params.programId,
  );
}

function u32Le(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value);
  return b;
}

function u8(value: number): Buffer {
  const b = Buffer.alloc(1);
  b.writeUInt8(value);
  return b;
}

function isFixedU8Array(type: ReceiptIdlArg['type'], length: number): type is { array: ['u8', number] } {
  return typeof type === 'object' && Array.isArray(type.array) && type.array[0] === 'u8' && type.array[1] === length;
}

function getRecordExecutionInstructionSpec(idlPath: string, programId: PublicKey): RecordExecutionInstructionSpec {
  const cacheKey = `${programId.toBase58()}:${idlPath}`;
  const cached = recordExecutionSpecCache.get(cacheKey);
  if (cached) return cached;

  const idl = loadReceiptIdlArtifact(idlPath, 'receipt');
  const idlAddress = typeof idl.address === 'string' ? idl.address.trim() : '';
  if (!idlAddress) {
    fail('RECEIPT_IDL_MISMATCH', 'receipt IDL is missing top-level address', { idlPath });
  }
  if (idlAddress !== programId.toBase58()) {
    fail('RECEIPT_IDL_MISMATCH', 'receipt IDL address does not match runtime program id', {
      idlPath,
      expectedProgramId: programId.toBase58(),
      actualProgramId: idlAddress,
    });
  }

  const instruction = Array.isArray(idl.instructions)
    ? idl.instructions.find((candidate) => candidate?.name === 'record_execution')
    : undefined;
  if (!instruction) {
    fail('RECEIPT_IDL_MISMATCH', 'receipt IDL is missing record_execution instruction', { idlPath });
  }

  if (
    !Array.isArray(instruction.discriminator) ||
    instruction.discriminator.length !== 8 ||
    instruction.discriminator.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  ) {
    fail('RECEIPT_IDL_MISMATCH', 'receipt IDL has invalid record_execution discriminator', {
      idlPath,
      discriminator: instruction.discriminator,
    });
  }
  if (!Array.isArray(instruction.args)) {
    fail('RECEIPT_IDL_MISMATCH', 'receipt IDL is missing record_execution args', { idlPath });
  }
  if (!Array.isArray(instruction.accounts)) {
    fail('RECEIPT_IDL_MISMATCH', 'receipt IDL is missing record_execution accounts', { idlPath });
  }

  const authority = instruction.accounts.find((account) => account?.name === 'authority');
  const receipt = instruction.accounts.find((account) => account?.name === 'receipt');
  const systemProgram = instruction.accounts.find((account) => account?.name === 'system_program');
  if (!authority || !receipt || !systemProgram) {
    fail('RECEIPT_IDL_MISMATCH', 'receipt IDL record_execution accounts do not match expected layout', {
      idlPath,
      accounts: instruction.accounts.map((account) => account?.name),
    });
  }

  const systemProgramAddress = typeof systemProgram.address === 'string' ? systemProgram.address.trim() : '';
  if (!systemProgramAddress) {
    fail('RECEIPT_IDL_MISMATCH', 'receipt IDL system_program account is missing address', { idlPath });
  }

  const spec: RecordExecutionInstructionSpec = {
    discriminator: Buffer.from(instruction.discriminator),
    args: instruction.args,
    accounts: instruction.accounts.map((account) => ({
      name: account.name,
      signer: Boolean(account.signer),
      writable: Boolean(account.writable),
      ...(typeof account.address === 'string' && account.address.trim() !== ''
        ? { address: new PublicKey(account.address.trim()) }
        : {}),
    })),
  };
  recordExecutionSpecCache.set(cacheKey, spec);
  return spec;
}

function encodeRecordExecutionArg(arg: ReceiptIdlArg, params: {
  epoch: number;
  direction: Direction;
  positionMint: PublicKey;
  attestationHash: Uint8Array;
}): Buffer {
  switch (arg.name) {
    case 'epoch':
      if (arg.type !== 'u32') fail('RECEIPT_IDL_MISMATCH', 'receipt IDL epoch arg is not u32', { arg });
      if (!Number.isInteger(params.epoch) || params.epoch < 0 || params.epoch > 0xffff_ffff) {
        throw new Error('epoch must be a u32');
      }
      return u32Le(params.epoch);
    case 'direction':
      if (arg.type !== 'u8') fail('RECEIPT_IDL_MISMATCH', 'receipt IDL direction arg is not u8', { arg });
      return u8(params.direction);
    case 'position_mint':
      if (arg.type !== 'pubkey') fail('RECEIPT_IDL_MISMATCH', 'receipt IDL position_mint arg is not pubkey', { arg });
      return params.positionMint.toBuffer();
    case 'attestation_hash':
      if (!isFixedU8Array(arg.type, 32)) {
        fail('RECEIPT_IDL_MISMATCH', 'receipt IDL attestation_hash arg is not [u8; 32]', { arg });
      }
      if (params.attestationHash.length !== 32) {
        throw new Error('attestationHash must be 32 bytes');
      }
      return Buffer.from(params.attestationHash);
    default:
      fail('RECEIPT_IDL_MISMATCH', 'receipt IDL contains unsupported record_execution arg', {
        argName: arg.name,
      });
  }
}

function decodeReceipt(info: AccountInfo<Buffer>): ReceiptAccount {
  const data = info.data;
  const hasInitializedFlag = data.length >= 127;
  const initializedOffset = 125;
  const bumpOffset = hasInitializedFlag ? 126 : 125;
  return {
    authority: new PublicKey(data.subarray(8, 40)),
    positionMint: new PublicKey(data.subarray(40, 72)),
    epoch: data.readUInt32LE(72),
    direction: data.readUInt8(76),
    attestationHash: data.subarray(77, 109),
    slot: data.readBigUInt64LE(109),
    unixTs: data.readBigInt64LE(117),
    initialized: hasInitializedFlag ? data.readUInt8(initializedOffset) === 1 : true,
    bump: data.readUInt8(bumpOffset),
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
  programId: PublicKey;
  idlPath?: string;
}): TransactionInstruction {
  if (params.attestationHash.length !== 32) {
    throw new Error('attestationHash must be 32 bytes');
  }

  const instructionSpec = getRecordExecutionInstructionSpec(params.idlPath ?? DEFAULT_RECEIPT_IDL_PATH, params.programId);
  const [receiptPda] = deriveReceiptPda({
    authority: params.authority,
    positionMint: params.positionMint,
    epoch: params.epoch,
    programId: params.programId,
  });

  const data = Buffer.concat([
    instructionSpec.discriminator,
    ...instructionSpec.args.map((arg) => encodeRecordExecutionArg(arg, params)),
  ]);

  const keys: AccountMeta[] = instructionSpec.accounts.map((account) => {
    switch (account.name) {
      case 'authority':
        return { pubkey: params.authority, isSigner: account.signer, isWritable: account.writable };
      case 'receipt':
        return { pubkey: receiptPda, isSigner: account.signer, isWritable: account.writable };
      case 'system_program':
        return { pubkey: account.address ?? SystemProgram.programId, isSigner: account.signer, isWritable: account.writable };
      default:
        fail('RECEIPT_IDL_MISMATCH', 'receipt IDL contains unsupported record_execution account', {
          accountName: account.name,
          idlPath: params.idlPath ?? DEFAULT_RECEIPT_IDL_PATH,
        });
    }
  });

  return new TransactionInstruction({ programId: params.programId, keys, data });
}
