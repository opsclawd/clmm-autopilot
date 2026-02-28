import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type TransactionInstruction,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { assertSolUsdcPair, decideSwap, hashAttestationPayload, type SwapPlan } from '@clmm-autopilot/core';
import { buildCreateAtaIdempotentIx, SOL_MINT } from './ata';
import type { PositionSnapshot } from './orcaInspector';
import { buildOrcaExitIxs, type OrcaExitIxs } from './orcaExitBuilder';
import { buildRecordExecutionIx, DISABLE_RECEIPT_PROGRAM_FOR_TESTING } from './receipt';
import { classifySimulationFailure, type SimulationDiagnostics } from './simErrors';
import type { CanonicalErrorCode } from './types';
import type { FeeBufferDebugPayload, FeeRequirementsBreakdown } from './requirements';
import { buildWsolLifecycleIxs, type WsolLifecycle } from './wsol';

export type ExitDirection = 'DOWN' | 'UP';
export type ExitQuote = {
  inputMint: PublicKey;
  outputMint: PublicKey;
  inAmount: bigint;
  outAmount: bigint;
  slippageBps: number;
  quotedAtUnixMs: number;
  raw?: unknown;
};

export type BuildExitConfig = {
  authority: PublicKey;
  payer: PublicKey;
  recentBlockhash: string;
  computeUnitLimit?: number;
  computeUnitPriceMicroLamports?: number;

  // Backward-compatible canonical quote fields retained as required for existing tests/callers.
  quote: ExitQuote;
  slippageBpsCap: number;
  quoteFreshnessMs: number;
  nowUnixMs: () => number;
  minSolLamportsToSwap: number;
  minUsdcMinorToSwap: number;

  swapPlan?: SwapPlan;
  quoteFreshnessSec?: number;
  nowUnixSec?: () => number;
  receiptEpochUnixMs: number;

  availableLamports: number;
  requirements: FeeRequirementsBreakdown;

  attestationHash: Uint8Array;
  attestationPayloadBytes: Uint8Array;

  swapIxs?: TransactionInstruction[];

  buildOrcaExitIxs?: (args: { snapshot: PositionSnapshot; authority: PublicKey; payer: PublicKey }) => OrcaExitIxs;
  buildWsolLifecycleIxs?: (args: {
    quote: { inputMint: PublicKey; outputMint: PublicKey; inAmount: bigint };
    authority: PublicKey;
    payer: PublicKey;
  }) => WsolLifecycle;
  buildJupiterSwapIxs?: (_args: { quote: ExitQuote; authority: PublicKey }) => Promise<{ instructions: TransactionInstruction[] }>;

  lookupTableAccounts?: AddressLookupTableAccount[];
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

function bytesEqualConstantTime(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

function canonicalEpoch(unixMs: number): number {
  return Math.floor(unixMs / 1000 / 86400);
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
  if (cfg.computeUnitLimit === undefined || cfg.computeUnitPriceMicroLamports === undefined) return [];
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cfg.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cfg.computeUnitPriceMicroLamports }),
  ];
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
  if (!config.attestationPayloadBytes || config.attestationPayloadBytes.length === 0) {
    fail('MISSING_ATTESTATION_HASH', 'attestationPayloadBytes are required', false);
  }
  const expected = hashAttestationPayload(config.attestationPayloadBytes);
  if (!bytesEqualConstantTime(expected, config.attestationHash)) {
    fail('MISSING_ATTESTATION_HASH', 'attestationHash must equal sha256(attestationPayloadBytes)', false);
  }

  assertSolUsdcPair(snapshot.tokenMintA.toBase58(), snapshot.tokenMintB.toBase58(), snapshot.cluster);

  const normalizedPlan: SwapPlan = (() => {
    if (config.swapPlan) return config.swapPlan;
    const decision = decideSwap(config.quote.inAmount, direction, {
      execution: {
        minSolLamportsToSwap: config.minSolLamportsToSwap,
        minUsdcMinorToSwap: config.minUsdcMinorToSwap,
      },
    });
    return {
      swapPlanned: decision.execute,
      swapSkipReason: decision.execute ? 'NONE' : 'DUST',
      swapRouter: 'jupiter',
      quote: {
        router: 'jupiter',
        inMint: config.quote.inputMint.toBase58(),
        outMint: config.quote.outputMint.toBase58(),
        swapInAmount: config.quote.inAmount,
        swapMinOutAmount: config.quote.outAmount,
        slippageBpsCap: config.quote.slippageBps,
        quotedAtUnixSec: Math.floor(config.quote.quotedAtUnixMs / 1000),
      },
    };
  })();

  const nowUnixSec = config.nowUnixSec ?? (() => Math.floor(config.nowUnixMs() / 1000));
  const quoteFreshnessSec = config.quoteFreshnessSec ?? Math.floor(config.quoteFreshnessMs / 1000);

  if (normalizedPlan.swapPlanned && nowUnixSec() - normalizedPlan.quote.quotedAtUnixSec > quoteFreshnessSec) {
    fail('QUOTE_STALE', 'Quote is stale', true, {
      quoteAgeSec: nowUnixSec() - normalizedPlan.quote.quotedAtUnixSec,
      quoteFreshnessSec,
    });
  }

  enforceFeeBuffer(config);

  const buildOrca = config.buildOrcaExitIxs ?? buildOrcaExitIxs;
  const orca = buildOrca({ snapshot, authority: config.authority, payer: config.payer });

  const buildWsol =
    config.buildWsolLifecycleIxs ??
    (({ quote, authority, payer }: { quote: { inputMint: PublicKey; outputMint: PublicKey; inAmount: bigint }; authority: PublicKey; payer: PublicKey }) =>
      buildWsolLifecycleIxs({
        authority,
        payer,
        inputMint: quote.inputMint,
        outputMint: quote.outputMint,
        wrapLamports: quote.inputMint.equals(SOL_MINT) ? quote.inAmount : undefined,
      }));

  const quoteIn = new PublicKey(normalizedPlan.quote.inMint);
  const quoteOut = new PublicKey(normalizedPlan.quote.outMint);

  const shouldExecuteSwap = normalizedPlan.swapPlanned;
  if (shouldExecuteSwap && (config.swapIxs?.length ?? 0) === 0) {
    fail('DATA_UNAVAILABLE', 'Swap is planned but no swap instructions were provided by adapter', false, {
      swapRouter: normalizedPlan.swapRouter,
      swapPlanned: normalizedPlan.swapPlanned,
      swapSkipReason: normalizedPlan.swapSkipReason,
      quote: {
        inMint: normalizedPlan.quote.inMint,
        outMint: normalizedPlan.quote.outMint,
        swapInAmount: normalizedPlan.quote.swapInAmount.toString(),
        swapMinOutAmount: normalizedPlan.quote.swapMinOutAmount.toString(),
      },
    });
  }

  const wsolRequired = shouldExecuteSwap && (quoteIn.equals(SOL_MINT) || quoteOut.equals(SOL_MINT));
  const wsolLifecycle = shouldExecuteSwap
      ? buildWsol({ quote: { inputMint: quoteIn, outputMint: quoteOut, inAmount: normalizedPlan.quote.swapInAmount }, authority: config.authority, payer: config.payer })
      : { preSwap: [], postSwap: [], wsolAta: undefined };

  const swapAtaIxs: TransactionInstruction[] = [];
  if (shouldExecuteSwap && !quoteIn.equals(SOL_MINT)) {
    swapAtaIxs.push(
      buildCreateAtaIdempotentIx({
        payer: config.payer,
        owner: config.authority,
        mint: quoteIn,
        tokenProgramId: tokenProgramForMint(quoteIn, snapshot),
      }).ix,
    );
  }
  if (shouldExecuteSwap && !quoteOut.equals(SOL_MINT)) {
    swapAtaIxs.push(
      buildCreateAtaIdempotentIx({
        payer: config.payer,
        owner: config.authority,
        mint: quoteOut,
        tokenProgramId: tokenProgramForMint(quoteOut, snapshot),
      }).ix,
    );
  }

  const receiptIx = DISABLE_RECEIPT_PROGRAM_FOR_TESTING
    ? null
    : buildRecordExecutionIx({
        authority: config.authority,
        positionMint: snapshot.positionMint,
        epoch: canonicalEpoch(config.receiptEpochUnixMs),
        direction: direction === 'DOWN' ? 0 : 1,
        attestationHash: config.attestationHash,
      });

  const instructions: TransactionInstruction[] = [
    ...buildComputeBudgetIxs(config),
    ...orca.conditionalAtaIxs,
    ...swapAtaIxs,
    ...(wsolRequired ? wsolLifecycle.preSwap : []),
    orca.removeLiquidityIx,
    orca.collectFeesIx,
    ...(shouldExecuteSwap ? (config.swapIxs ?? []) : []),
    ...(wsolRequired ? wsolLifecycle.postSwap : []),
    ...(receiptIx ? [receiptIx] : []),
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
