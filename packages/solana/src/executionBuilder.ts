import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import { buildRecordExecutionIx } from './receipt';
import type { PositionSnapshot } from './orcaInspector';
import type { CanonicalErrorCode } from './types';

const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

export type ExitDirection = 'DOWN' | 'UP';

export type ExitQuote = {
  inputMint: PublicKey;
  outputMint: PublicKey;
  slippageBps: number;
  quotedAtUnixMs: number;
};

export type BuildExitConfig = {
  authority: PublicKey;
  payer: PublicKey;
  recentBlockhash: string;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: number;
  conditionalAtaIxs?: TransactionInstruction[];
  removeLiquidityIx: TransactionInstruction;
  collectFeesIx: TransactionInstruction;
  jupiterSwapIx: TransactionInstruction;
  buildWsolLifecycleIxs?: (direction: ExitDirection) => {
    preSwap: TransactionInstruction[];
    postSwap: TransactionInstruction[];
  };
  quote: ExitQuote;
  maxSlippageBps: number;
  quoteFreshnessMs: number;
  maxRebuildAttempts: number;
  nowUnixMs: () => number;
  rebuildSnapshotAndQuote?: () => Promise<{ snapshot: PositionSnapshot; quote: ExitQuote }>;
  availableLamports: number;
  estimatedNetworkFeeLamports: number;
  estimatedPriorityFeeLamports: number;
  estimatedRentLamports: number;
  estimatedAtaCreateLamports: number;
  feeBufferLamports: number;
  attestationHash: Uint8Array;
  simulate: (message: TransactionMessage) => Promise<{ err: unknown | null; accountsResolved: boolean }>;
  returnVersioned?: boolean;
};

export type BuildExitResult = VersionedTransaction | TransactionMessage;

type TypedError = Error & { code: CanonicalErrorCode; retryable: boolean };

function fail(code: CanonicalErrorCode, message: string, retryable: boolean): never {
  const err = new Error(message) as TypedError;
  err.code = code;
  err.retryable = retryable;
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
  const projectedCost =
    cfg.estimatedNetworkFeeLamports +
    cfg.estimatedPriorityFeeLamports +
    cfg.estimatedRentLamports +
    cfg.estimatedAtaCreateLamports;
  const remaining = cfg.availableLamports - projectedCost;
  if (remaining < cfg.feeBufferLamports) {
    fail('INSUFFICIENT_FEE_BUFFER', 'Insufficient fee buffer after projected costs', false);
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

export async function buildExitTransaction(
  snapshot: PositionSnapshot,
  direction: ExitDirection,
  config: BuildExitConfig,
): Promise<BuildExitResult> {
  if (config.attestationHash.length !== 32) {
    fail('DATA_UNAVAILABLE', 'attestationHash must be exactly 32 bytes', false);
  }

  const refreshed = await resolveFreshSnapshotAndQuote(snapshot, config);
  assertQuoteDirection(direction, refreshed.quote, refreshed.snapshot);

  if (refreshed.quote.slippageBps > config.maxSlippageBps) {
    fail('SLIPPAGE_EXCEEDED', 'Quote slippage exceeds configured cap', false);
  }

  enforceFeeBuffer(config);

  if (!config.buildWsolLifecycleIxs) {
    fail('DATA_UNAVAILABLE', 'WSOL lifecycle builder is required for SOL-side swap handling', false);
  }
  const maybeWsolLifecycle = config.buildWsolLifecycleIxs(direction);
  const wsolRequired = refreshed.quote.inputMint.equals(SOL_MINT) || refreshed.quote.outputMint.equals(SOL_MINT);

  const receiptIx = buildRecordExecutionIx({
    authority: config.authority,
    positionMint: refreshed.snapshot.positionMint,
    epoch: canonicalEpoch(config.nowUnixMs()),
    direction: direction === 'DOWN' ? 0 : 1,
    attestationHash: config.attestationHash,
  });

  const instructions: TransactionInstruction[] = [
    ...buildComputeBudgetIxs(config),
    ...(config.conditionalAtaIxs ?? []),
    ...(wsolRequired ? maybeWsolLifecycle.preSwap : []),
    config.removeLiquidityIx,
    config.collectFeesIx,
    config.jupiterSwapIx,
    ...(wsolRequired ? maybeWsolLifecycle.postSwap : []),
    receiptIx,
  ];

  const message = new TransactionMessage({
    payerKey: config.payer,
    recentBlockhash: config.recentBlockhash,
    instructions,
  });

  const simulation = await config.simulate(message);
  if (simulation.err !== null || !simulation.accountsResolved) {
    fail('SIMULATION_FAILED', 'simulate-then-send gate failed', false);
  }

  if (config.returnVersioned) {
    return new VersionedTransaction(message.compileToV0Message([]));
  }

  return message;
}
