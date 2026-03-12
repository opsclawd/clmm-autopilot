import type { Connection, PublicKey } from '@solana/web3.js';
import { AccountLayout } from '@solana/spl-token';
import type { PositionSnapshot } from './orcaInspector';
import { type AtaPlanEntry, getAta, SOL_MINT } from './ata';
import { resolveTokenProgramForMint } from './token/program';
import { TOKEN_PROGRAM_ID } from './token/constants';

export type FeeRequirementsBreakdown = {
  rentLamports: number;
  ataCount: number;
  missingAtas: AtaPlanEntry[];
  txFeeLamports: number;
  priorityFeeLamports: number;
  totalRequiredLamports: number;
  bufferLamports: number;
};

export type RequirementsInput = {
  connection: Pick<Connection, 'getAccountInfo' | 'getMinimumBalanceForRentExemption'>;
  snapshot: Pick<PositionSnapshot, 'positionMint' | 'positionTokenProgram' | 'tokenMintA' | 'tokenMintB' | 'tokenProgramA' | 'tokenProgramB'>;
  quote: { inputMint: PublicKey; outputMint: PublicKey };
  swapPlanned: boolean;

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

  const ataPlans = new Map<string, AtaPlanEntry>();
  const addAta = (mint: PublicKey, tokenProgramId: PublicKey) => {
    const ata = getAta(mint, input.authority, tokenProgramId);
    const key = ata.toBase58();
    if (ataPlans.has(key)) return;
    ataPlans.set(key, {
      ata,
      mint,
      owner: input.authority,
      tokenProgramId,
    });
  };

  // Orca exit always needs these token accounts (position token + the pool mints A/B).
  const positionTokenProgramId =
    input.snapshot.positionTokenProgram ?? (await resolveTokenProgramForMint(input.connection, input.snapshot.positionMint)).tokenProgramId;
  addAta(input.snapshot.positionMint, positionTokenProgramId);
  addAta(input.snapshot.tokenMintA, input.snapshot.tokenProgramA);
  addAta(input.snapshot.tokenMintB, input.snapshot.tokenProgramB);

  if (input.swapPlanned) {
    const resolveQuoteTokenProgramId = async (mint: PublicKey): Promise<PublicKey> => {
      if (mint.equals(input.snapshot.tokenMintA)) return input.snapshot.tokenProgramA;
      if (mint.equals(input.snapshot.tokenMintB)) return input.snapshot.tokenProgramB;
      return (await resolveTokenProgramForMint(input.connection, mint)).tokenProgramId;
    };

    // Swap ATAs for input/output mints when those are SPL tokens.
    if (!input.quote.inputMint.equals(SOL_MINT)) {
      addAta(input.quote.inputMint, await resolveQuoteTokenProgramId(input.quote.inputMint));
    }
    if (!input.quote.outputMint.equals(SOL_MINT)) {
      addAta(input.quote.outputMint, await resolveQuoteTokenProgramId(input.quote.outputMint));
    }
    // WSOL ATA when swap involves SOL (wrap/unwrap lifecycle uses native mint ATA).
    if (involvesSol) addAta(SOL_MINT, TOKEN_PROGRAM_ID);
  }

  const plannedAtas = Array.from(ataPlans.values());

  const exists = await Promise.all(plannedAtas.map((entry) => accountExists(input.connection, entry.ata)));
  const missingAtas = plannedAtas.filter((_, i) => !exists[i]);
  const missingAtaCount = missingAtas.length;

  // All ATAs are SPL Token accounts, same size.
  const tokenAccountRent = await input.connection.getMinimumBalanceForRentExemption(AccountLayout.span);
  const rentLamports = tokenAccountRent * missingAtaCount;

  const computeUnitLimit = input.computeUnitLimit ?? 0;
  const computeUnitPriceMicroLamports = input.computeUnitPriceMicroLamports ?? 0;
  const priorityFeeLamports = Math.ceil((computeUnitLimit * computeUnitPriceMicroLamports) / 1_000_000);

  const totalRequiredLamports = rentLamports + input.txFeeLamports + priorityFeeLamports + input.bufferLamports;

  return {
    rentLamports,
    ataCount: missingAtaCount,
    missingAtas,
    txFeeLamports: input.txFeeLamports,
    priorityFeeLamports,
    totalRequiredLamports,
    bufferLamports: input.bufferLamports,
  };
}
