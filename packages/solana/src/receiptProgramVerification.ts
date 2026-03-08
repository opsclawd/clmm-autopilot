import { PublicKey, type Connection } from '@solana/web3.js';
import type { ReceiptRuntimeIdentity } from './receiptIdentity';
import type { CanonicalErrorCode } from './types';

type TypedError = Error & { code: CanonicalErrorCode; retryable: boolean; debug?: unknown };

export type ReceiptProgramVerificationResult = {
  programId: string;
  owner: string;
  programDataAddress?: string;
  upgradeAuthority?: string;
};

export const BPF_UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

function fail(message: string): never {
  const err = new Error(message) as TypedError;
  err.code = 'RECEIPT_PROGRAM_VERIFICATION_FAILED';
  err.retryable = false;
  throw err;
}

function parsedInfoField(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const data = value as { data?: unknown };
  if (!data.data || typeof data.data !== 'object') return undefined;
  const parsed = data.data as { parsed?: unknown };
  if (!parsed.parsed || typeof parsed.parsed !== 'object') return undefined;
  const info = parsed.parsed as { info?: unknown };
  if (!info.info || typeof info.info !== 'object') return undefined;
  return (info.info as Record<string, unknown>)[key];
}

export async function verifyReceiptProgramOnChain(
  connection: Pick<Connection, 'getAccountInfo' | 'getParsedAccountInfo'>,
  identity: ReceiptRuntimeIdentity,
): Promise<ReceiptProgramVerificationResult> {
  const programInfo = await connection.getAccountInfo(identity.programId, 'confirmed');
  if (!programInfo) {
    fail('Receipt program account not found on cluster');
  }
  if (!programInfo.executable) {
    fail('Receipt program account is not executable');
  }
  if (!programInfo.owner.equals(BPF_UPGRADEABLE_LOADER)) {
    fail('Receipt program is not owned by upgradeable loader');
  }

  const verification: ReceiptProgramVerificationResult = {
    programId: identity.programId.toBase58(),
    owner: programInfo.owner.toBase58(),
  };

  if (!identity.expectedUpgradeAuthority) return verification;

  const parsedProgram = await connection.getParsedAccountInfo(identity.programId, 'confirmed');
  const programDataAddress = parsedInfoField(parsedProgram.value, 'programData');
  if (typeof programDataAddress !== 'string') {
    fail('ProgramData address missing while expectedUpgradeAuthority is configured');
  }

  const parsedProgramData = await connection.getParsedAccountInfo(new PublicKey(programDataAddress), 'confirmed');
  const parsedAuthority =
    parsedInfoField(parsedProgramData.value, 'authority') ?? parsedInfoField(parsedProgramData.value, 'upgradeAuthority');
  if (typeof parsedAuthority !== 'string') {
    fail('Upgrade authority missing on ProgramData account while strict authority check is enabled');
  }
  if (parsedAuthority !== identity.expectedUpgradeAuthority.toBase58()) {
    fail('Upgrade authority mismatch for receipt program');
  }

  return {
    ...verification,
    programDataAddress,
    upgradeAuthority: parsedAuthority,
  };
}
