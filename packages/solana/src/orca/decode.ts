import { ParsablePosition, ParsableTickArray, ParsableWhirlpool } from '@orca-so/whirlpools-sdk';
import { PublicKey, type AccountInfo } from '@solana/web3.js';
import type { NormalizedError } from '../types';

const DUMMY_ADDRESS = new PublicKey('11111111111111111111111111111111');

type PositionData = NonNullable<ReturnType<typeof ParsablePosition.parse>>;
type WhirlpoolData = NonNullable<ReturnType<typeof ParsableWhirlpool.parse>>;
type TickArrayData = NonNullable<ReturnType<typeof ParsableTickArray.parse>>;

function decodeFailed(message: string, debug?: unknown): NormalizedError {
  return {
    code: 'ORCA_DECODE_FAILED',
    message,
    retryable: false,
    debug,
  };
}

function asAccountInfo(data: Buffer): AccountInfo<Buffer> {
  return {
    data,
    executable: false,
    lamports: 0,
    owner: DUMMY_ADDRESS,
    rentEpoch: 0,
  };
}

function parseOrThrow<T>(
  data: Buffer,
  parser: (address: PublicKey, accountData: AccountInfo<Buffer>) => T | null,
  accountName: string,
): T {
  try {
    const parsed = parser(DUMMY_ADDRESS, asAccountInfo(data));
    if (!parsed) {
      throw decodeFailed(`Failed to decode Orca ${accountName} account`, {
        accountName,
        dataLen: data.length,
        discriminatorHex: data.subarray(0, 8).toString('hex'),
      });
    }
    return parsed;
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && (error as { code?: string }).code === 'ORCA_DECODE_FAILED') {
      throw error;
    }

    throw decodeFailed(`Failed to decode Orca ${accountName} account`, {
      accountName,
      dataLen: data.length,
      discriminatorHex: data.subarray(0, 8).toString('hex'),
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export function decodeWhirlpoolAccount(data: Buffer): WhirlpoolData {
  return parseOrThrow(data, ParsableWhirlpool.parse, 'Whirlpool');
}

export function decodePositionAccount(data: Buffer): PositionData {
  return parseOrThrow(data, ParsablePosition.parse, 'Position');
}

export function decodeTickArrayAccount(data: Buffer): TickArrayData {
  return parseOrThrow(data, ParsableTickArray.parse, 'TickArray');
}
