import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type TransactionInstruction,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { assertSolUsdcPair, hashAttestationPayload } from '@clmm-autopilot/core';
import { buildCreateAtaIdempotentIx, SOL_MINT } from './ata';
import { fetchJupiterSwapIxs, type JupiterQuote, type JupiterSwapIxs } from './jupiter';
import type { PositionSnapshot } from './orcaInspector';
import { buildOrcaExitIxs, type OrcaExitIxs } from './orcaExitBuilder';
import { buildRecordExecutionIx } from './receipt';
import { classifySimulationFailure, type SimulationDiagnostics } from './simErrors';
import type { CanonicalErrorCode } from './types';
import type { FeeBufferDebugPayload, FeeRequirementsBreakdown } from './requirements';
import { buildWsolLifecycleIxs, type WsolLifecycle } from './wsol';

export type ExitDirection = 'DOWN' | 'UP';

// Phase-1 canonical quote type used by the execution builder.
export type ExitQuote = Pick<JupiterQuote, 'inputMint' | 'outputMint' | 'inAmount' | 'outAmount' | 'slippageBps' | 'quotedAtUnixMs'> & {
  raw?: JupiterQuote['raw'];
};

export type BuildExitConfig = {
  authority: PublicKey;
  payer: PublicKey;
  recentBlockhash: string;

  computeUnitLimit: number;
  computeUnitPriceMicroLamports: number;

  // Quote + guardrails.
  quote: ExitQuote;
  maxSlippageBps: number;
  quoteFreshnessMs: number;
  maxRebuildAttempts: number;
  nowUnixMs: () => number;
  rebuildSnapshotAndQuote?: () => Promise<{ snapshot: PositionSnapshot; quote: ExitQuote }>;

  // Cost guardrails.
  availableLamports: number;
  requirements: FeeRequirementsBreakdown;

  // Receipt.
  attestationHash: Uint8Array;
  attestationPayloadBytes?: Uint8Array;

  // Builder deps (override in tests). Defaults construct real Orca/Jupiter/WSOL modules.
  buildOrcaExitIxs?: (args: { snapshot: PositionSnapshot; authority: PublicKey; payer: PublicKey }) => OrcaExitIxs;
  buildJupiterSwapIxs?: (args: { quote: ExitQuote; authority: PublicKey }) => Promise<JupiterSwapIxs>;
  buildWsolLifecycleIxs?: (args: { quote: ExitQuote; authority: PublicKey; payer: PublicKey }) => WsolLifecycle;

  lookupTableAccounts?: AddressLookupTableAccount[];

  // Mandatory simulation gate (must be run against the exact tx message that will be signed).
  simulate: (tx: VersionedTransaction) => Promise<SimulationDiagnostics>;

  returnVersioned?: boolean;
};

export type BuildExitResult = VersionedTransaction | TransactionMessage;

type TypedError = Error & { code: CanonicalErrorCode; retryable: boolean; debug?: unknown };

function fail(code: CanonicalErrorCode, message: string, retryable: boolean, debug?: unknown): never {
  const err = new Error(message) as TypedError;
  err.code = code;
  err.retryable = retryable;
  if (debug !== undefined) err.debug = debug;
  throw err;
}

function canonicalEpoch(unixMs: number): number {
  return Math.floor(unixMs / 1000 / 86400);
}

function assertQuoteDirection(direction: ExitDirection, quote: ExitQuote, snapshot: PositionSnapshot): void {
  const nonSolMint = snapshot.tokenMintA.equals(SOL_MINT) ? snapshot.tokenMintB : snapshot.tokenMintA;

  if (direction === 'DOWN') {
    if (!quote.inputMint.equals(SOL_MINT) || !quote.outputMint.equals(nonSolMint)) {
      fail('NOT_SOL_USDC', 'DOWN direction must route SOL->USDC-side mint from snapshot', false);
    }
    return;
  }

  if (!quote.inputMint.equals(nonSolMint) || !quote.outputMint.equals(SOL_MINT)) {
    fail('NOT_SOL_USDC', 'UP direction must route USDC-side mint from snapshot->SOL', false);
  }
}

function enforceFeeBuffer(cfg: BuildExitConfig): void {
  const required = cfg.requirements.totalRequiredLamports;
  if (cfg.availableLamports < required) {
    const deficitLamports = required - cfg.availableLamports;
    const debug: FeeBufferDebugPayload = {
      availableLamports: cfg.availableLamports,
      requirements: cfg.requirements,
      deficitLamports,
      notes: [
        'requirements.totalRequiredLamports = rentLamports + txFeeLamports + priorityFeeLamports + bufferLamports',
        'rentLamports is derived from missing ATA count * rent exemption for token account size',
      ],
    };
    fail('INSUFFICIENT_FEE_BUFFER', 'Insufficient lamports for projected execution costs + fee buffer', false, debug);
  }
}

function buildComputeBudgetIxs(cfg: BuildExitConfig): TransactionInstruction[] {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cfg.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cfg.computeUnitPriceMicroLamports }),
  ];
}

async function resolveFreshSnapshotAndQuote(
  snapshot: PositionSnapshot,
  config: BuildExitConfig,
): Promise<{ snapshot: PositionSnapshot; quote: ExitQuote }> {
  const start = config.nowUnixMs();
  let currentSnapshot = snapshot;
  let currentQuote = config.quote;
  let attempts = 0;

  while (config.nowUnixMs() - currentQuote.quotedAtUnixMs > config.quoteFreshnessMs) {
    if (!config.rebuildSnapshotAndQuote) {
      fail('QUOTE_STALE', 'Quote is stale and no rebuild function was provided', true);
    }
    if (attempts >= config.maxRebuildAttempts) {
      fail('QUOTE_STALE', 'Quote is stale and rebuild attempts exhausted', true);
    }
    if (config.nowUnixMs() - start > 15_000) {
      fail('QUOTE_STALE', 'Quote is stale and rebuild window exceeded 15s', true);
    }

    const rebuilt = await config.rebuildSnapshotAndQuote();
    currentSnapshot = rebuilt.snapshot;
    currentQuote = rebuilt.quote;
    attempts += 1;
  }

  return { snapshot: currentSnapshot, quote: currentQuote };
}

function tokenProgramForMint(mint: PublicKey, snapshot: PositionSnapshot): PublicKey {
  if (mint.equals(snapshot.tokenMintA)) return snapshot.tokenProgramA;
  if (mint.equals(snapshot.tokenMintB)) return snapshot.tokenProgramB;
  return TOKEN_PROGRAM_ID;
}

export async function buildExitTransaction(
  snapshot: PositionSnapshot,
  direction: ExitDirection,
  config: BuildExitConfig,
): Promise<BuildExitResult> {
  if (config.attestationHash.length !== 32) {
    fail('MISSING_ATTESTATION_HASH', 'attestationHash must be exactly 32 bytes', false);
  }
  if (config.attestationHash.every((b) => b === 0)) {
    fail('MISSING_ATTESTATION_HASH', 'attestationHash must be non-zero', false);
  }
  if (config.attestationPayloadBytes) {
    const expected = hashAttestationPayload(config.attestationPayloadBytes);
    if (Buffer.from(expected).compare(Buffer.from(config.attestationHash)) !== 0) {
      fail('MISSING_ATTESTATION_HASH', 'attestationHash must equal sha256(attestationPayloadBytes)', false);
    }
  }

  assertSolUsdcPair(snapshot.tokenMintA.toBase58(), snapshot.tokenMintB.toBase58(), snapshot.cluster);

  const refreshed = await resolveFreshSnapshotAndQuote(snapshot, config);
  assertQuoteDirection(direction, refreshed.quote, refreshed.snapshot);

  if (refreshed.quote.slippageBps > config.maxSlippageBps) {
    fail('SLIPPAGE_EXCEEDED', 'Quote slippage exceeds configured cap', false);
  }

  enforceFeeBuffer(config);

  const buildOrca = config.buildOrcaExitIxs ?? buildOrcaExitIxs;
  const orca = buildOrca({ snapshot: refreshed.snapshot, authority: config.authority, payer: config.payer });

  const buildJup =
    config.buildJupiterSwapIxs ??
    (async ({ quote, authority }: { quote: ExitQuote; authority: PublicKey }) => {
      if (!quote.raw) throw new Error('quote.raw required for default Jupiter swap builder');
      return fetchJupiterSwapIxs({ quote: quote as JupiterQuote, userPublicKey: authority, wrapAndUnwrapSol: false });
    });
  const jup = await buildJup({ quote: refreshed.quote, authority: config.authority });

  const buildWsol =
    config.buildWsolLifecycleIxs ??
    (({ quote, authority, payer }: { quote: ExitQuote; authority: PublicKey; payer: PublicKey }) =>
      buildWsolLifecycleIxs({
        authority,
        payer,
        inputMint: quote.inputMint,
        outputMint: quote.outputMint,
        wrapLamports: quote.inputMint.equals(SOL_MINT) ? quote.inAmount : undefined,
      }));

  const wsolLifecycle = buildWsol({ quote: refreshed.quote, authority: config.authority, payer: config.payer });
  const wsolRequired = refreshed.quote.inputMint.equals(SOL_MINT) || refreshed.quote.outputMint.equals(SOL_MINT);

  // Ensure Jupiter input/output ATAs exist (idempotent). If the mint is the pool mint, we use the pool's token program.
  const jupiterAtaIxs: TransactionInstruction[] = [];
  if (!refreshed.quote.inputMint.equals(SOL_MINT)) {
    jupiterAtaIxs.push(
      buildCreateAtaIdempotentIx({
        payer: config.payer,
        owner: config.authority,
        mint: refreshed.quote.inputMint,
        tokenProgramId: tokenProgramForMint(refreshed.quote.inputMint, refreshed.snapshot),
      }).ix,
    );
  }
  if (!refreshed.quote.outputMint.equals(SOL_MINT)) {
    jupiterAtaIxs.push(
      buildCreateAtaIdempotentIx({
        payer: config.payer,
        owner: config.authority,
        mint: refreshed.quote.outputMint,
        tokenProgramId: tokenProgramForMint(refreshed.quote.outputMint, refreshed.snapshot),
      }).ix,
    );
  }

  const receiptIx = buildRecordExecutionIx({
    authority: config.authority,
    positionMint: refreshed.snapshot.positionMint,
    epoch: canonicalEpoch(config.nowUnixMs()),
    direction: direction === 'DOWN' ? 0 : 1,
    attestationHash: config.attestationHash,
  });

  const instructions: TransactionInstruction[] = [
    ...buildComputeBudgetIxs(config),
    ...orca.conditionalAtaIxs,
    ...jupiterAtaIxs,
    ...(wsolRequired ? wsolLifecycle.preSwap : []),
    orca.removeLiquidityIx,
    orca.collectFeesIx,
    ...jup.instructions,
    ...(wsolRequired ? wsolLifecycle.postSwap : []),
    receiptIx,
  ];

  const message = new TransactionMessage({
    payerKey: config.payer,
    recentBlockhash: config.recentBlockhash,
    instructions,
  });

  const v0 = message.compileToV0Message(config.lookupTableAccounts ?? []);
  const tx = new VersionedTransaction(v0);

  const simulation = await config.simulate(tx);
  if (simulation.err !== null) {
    const mapped = classifySimulationFailure(simulation);
    fail(mapped.code, mapped.message, false, mapped.debug);
  }

  if (config.returnVersioned) return tx;
  return message;
}
