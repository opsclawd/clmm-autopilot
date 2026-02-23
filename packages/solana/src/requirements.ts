import type { PublicKey } from '@solana/web3.js';

export type FeeRequirementsBreakdown = {
  rentLamports: number;
  ataCount: number;
  txFeeLamports: number;
  priorityFeeLamports: number;
  totalRequiredLamports: number;
  bufferLamports: number;
};

export type RequirementsInput = {
  owner: PublicKey;
  payer: PublicKey;
};

export async function computeExecutionRequirements(_input: RequirementsInput): Promise<FeeRequirementsBreakdown> {
  throw new Error('Not implemented yet');
}
