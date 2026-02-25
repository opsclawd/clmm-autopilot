import type { Connection, PublicKey } from '@solana/web3.js';
import { AccountLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import type { PositionSnapshot } from './orcaInspector';
import { getAta, SOL_MINT } from './ata';

export type FeeRequirementsBreakdown = {
  rentLamports: number;
  ataCount: number;
  txFeeLamports: number;
  priorityFeeLamports: number;
  totalRequiredLamports: number;
  bufferLamports: number;
};

export type RequirementsInput = {
  connection: Pick<Connection, 'getAccountInfo' | 'getMinimumBalanceForRentExemption'>;
  snapshot: Pick<PositionSnapshot, 'positionMint' | 'tokenMintA' | 'tokenMintB' | 'tokenProgramA' | 'tokenProgramB'>;
  quote: { inputMint: PublicKey; outputMint: PublicKey };

  authority: PublicKey;
  payer: PublicKey;

  /** Expected base network fee (signature fee) strategy, in lamports. */
  txFeeLamports: number;
  /** Priority fee strategy based on compute budget settings. */
  computeUnitLimit?: number;
  computeUnitPriceMicroLamports?: number;
  /** Additional lamports reserved as a safety buffer. */
  bufferLamports: number;
};

export type FeeBufferDebugPayload = {
  availableLamports: number;
  requirements: FeeRequirementsBreakdown;
  deficitLamports: number;
  notes: string[];
};

async function accountExists(connection: Pick<Connection, 'getAccountInfo'>, pubkey: PublicKey): Promise<boolean> {
  const info = await connection.getAccountInfo(pubkey);
  return info !== null;
}

export async function computeExecutionRequirements(input: RequirementsInput): Promise<FeeRequirementsBreakdown> {
  const involvesSol = input.quote.inputMint.equals(SOL_MINT) || input.quote.outputMint.equals(SOL_MINT);

  const ataAddresses = new Map<string, PublicKey>();
  const addAta = (mint: PublicKey, tokenProgramId: PublicKey = TOKEN_PROGRAM_ID) => {
    const ata = getAta(mint, input.authority, tokenProgramId);
    ataAddresses.set(ata.toBase58(), ata);
  };

  // Orca exit always needs these token accounts (position token + the pool mints A/B).
  addAta(input.snapshot.positionMint);
  addAta(input.snapshot.tokenMintA, input.snapshot.tokenProgramA);
  addAta(input.snapshot.tokenMintB, input.snapshot.tokenProgramB);

  // Jupiter swap ATAs for input/output mints when those are SPL tokens.
  if (!input.quote.inputMint.equals(SOL_MINT)) addAta(input.quote.inputMint);
  if (!input.quote.outputMint.equals(SOL_MINT)) addAta(input.quote.outputMint);

  // WSOL ATA when the swap involves SOL (wrap/unwrap lifecycle uses the native mint ATA).
  if (involvesSol) addAta(SOL_MINT, TOKEN_PROGRAM_ID);

  const uniqueAtas = Array.from(ataAddresses.values());

  const exists = await Promise.all(uniqueAtas.map((k) => accountExists(input.connection, k)));
  const missingAtas = exists.reduce((acc, ok) => acc + (ok ? 0 : 1), 0);

  // All ATAs are SPL Token accounts, same size.
  const tokenAccountRent = await input.connection.getMinimumBalanceForRentExemption(AccountLayout.span);
  const rentLamports = tokenAccountRent * missingAtas;

  const computeUnitLimit = input.computeUnitLimit ?? 0;
  const computeUnitPriceMicroLamports = input.computeUnitPriceMicroLamports ?? 0;
  const priorityFeeLamports = Math.ceil((computeUnitLimit * computeUnitPriceMicroLamports) / 1_000_000);

  const totalRequiredLamports = rentLamports + input.txFeeLamports + priorityFeeLamports + input.bufferLamports;

  return {
    rentLamports,
    ataCount: missingAtas,
    txFeeLamports: input.txFeeLamports,
    priorityFeeLamports,
    totalRequiredLamports,
    bufferLamports: input.bufferLamports,
  };
}
