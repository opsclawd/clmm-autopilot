import { evaluateRangeBreak, type Sample } from '@clmm-autopilot/core';
import { Connection, PublicKey, VersionedTransaction, type TransactionInstruction } from '@solana/web3.js';
import { buildExitTransaction, type ExitDirection, type ExitQuote } from './executionBuilder';
import { normalizeSolanaError } from './errors';
import { loadPositionSnapshot } from './orcaInspector';
import { deriveReceiptPda, fetchReceiptByPda } from './receipt';
import { refreshBlockhashIfNeeded, shouldRebuild, withBoundedRetry } from './reliability';
import type { CanonicalErrorCode } from './types';

type Logger = {
  notify?: (info: string, context?: Record<string, string | number | boolean>) => void;
  notifyError?: (err: unknown, context?: Record<string, string | number | boolean>) => void;
};

export type RefreshParams = {
  connection: Connection;
  position: PublicKey;
  samples: Sample[];
  slippageBpsCap: number;
  expectedMinOut: string;
  quoteAgeMs: number;
};

export type RefreshResult = {
  snapshot: {
    positionAddress: string;
    currentTick: number;
    lowerTick: number;
    upperTick: number;
    inRange: boolean;
  };
  decision: {
    decision: 'HOLD' | 'TRIGGER_DOWN' | 'TRIGGER_UP';
    reasonCode: string;
    samplesUsed: number;
    threshold: number;
    cooldownRemainingMs: number;
  };
  quote: { slippageBpsCap: number; expectedMinOut: string; quoteAgeMs: number };
};

export async function refreshPositionDecision(params: RefreshParams): Promise<RefreshResult> {
  const snapshot = await loadPositionSnapshot(params.connection, params.position);
  const decision = evaluateRangeBreak(
    params.samples,
    { lowerTickIndex: snapshot.lowerTickIndex, upperTickIndex: snapshot.upperTickIndex },
    { requiredConsecutive: 3, cadenceMs: 2000, cooldownMs: 90_000 },
  );

  return {
    snapshot: {
      positionAddress: params.position.toBase58(),
      currentTick: snapshot.currentTickIndex,
      lowerTick: snapshot.lowerTickIndex,
      upperTick: snapshot.upperTickIndex,
      inRange: snapshot.inRange,
    },
    decision: {
      decision: decision.action,
      reasonCode: decision.reasonCode,
      samplesUsed: decision.debug.samplesUsed,
      threshold: decision.debug.threshold,
      cooldownRemainingMs: decision.debug.cooldownRemainingMs,
    },
    quote: { slippageBpsCap: params.slippageBpsCap, expectedMinOut: params.expectedMinOut, quoteAgeMs: params.quoteAgeMs },
  };
}

export type ExecuteOnceParams = RefreshParams & {
  authority: PublicKey;
  quote: ExitQuote;
  quoteContext?: { quotedAtSlot?: number; quoteTickIndex?: number };
  removeLiquidityIx: TransactionInstruction;
  collectFeesIx: TransactionInstruction;
  swapIx: TransactionInstruction;
  wsolLifecycleIxs: { preSwap: TransactionInstruction[]; postSwap: TransactionInstruction[] };
  attestationHash: Uint8Array;
  signAndSend: (tx: VersionedTransaction) => Promise<string>;
  rebuildSnapshotAndQuote?: () => Promise<{ snapshot: Awaited<ReturnType<typeof loadPositionSnapshot>>; quote: ExitQuote; quoteContext?: { quotedAtSlot?: number; quoteTickIndex?: number } }>;
  sleep?: (ms: number) => Promise<void>;
  nowUnixMs?: () => number;
  checkExistingReceipt?: (receiptPda: PublicKey) => Promise<boolean>;
  onSimulationComplete?: (summary: string) => Promise<void> | void;
  logger?: Logger;
};

export type ExecuteOnceResult = {
  refresh?: RefreshResult;
  execution?: {
    unsignedTxBuilt: boolean;
    simulated: boolean;
    simLogs?: string[];
    sendSig?: string;
    receiptPda?: string;
    receiptFetched?: boolean;
    receiptFields?: string;
  };
  txSignature?: string;
  receiptPda?: string;
  errorCode?: CanonicalErrorCode;
  errorMessage?: string;
  simSummary?: string;
};

export async function executeOnce(params: ExecuteOnceParams): Promise<ExecuteOnceResult> {
  const sleep = params.sleep ?? (async (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const nowUnixMs = params.nowUnixMs ?? (() => Date.now());

  try {
    const refreshed = await withBoundedRetry(() => refreshPositionDecision(params), sleep, 3);
    params.logger?.notify?.('snapshot fetched', { position: params.position.toBase58() });

    if (refreshed.decision.decision === 'HOLD') {
      return { refresh: refreshed, errorCode: 'DATA_UNAVAILABLE', errorMessage: 'Execution blocked while decision is HOLD' };
    }

    let snapshot = await withBoundedRetry(() => loadPositionSnapshot(params.connection, params.position), sleep, 3);
    let quote = params.quote;
    let quoteContext = params.quoteContext;
    const latestSlot = await withBoundedRetry(() => params.connection.getSlot('confirmed'), sleep, 3);

    const rebuildCheck = shouldRebuild(
      { quotedAtUnixMs: quote.quotedAtUnixMs, quotedAtSlot: quoteContext?.quotedAtSlot, quoteTickIndex: quoteContext?.quoteTickIndex },
      snapshot,
      { nowUnixMs: nowUnixMs(), latestSlot, quoteFreshnessMs: 20_000, maxSlotDrift: 8 },
    );

    if (rebuildCheck.rebuild) {
      if (!params.rebuildSnapshotAndQuote) {
        return { refresh: refreshed, errorCode: 'QUOTE_STALE', errorMessage: `Rebuild required: ${rebuildCheck.reasonCode}` };
      }
      const rebuilt = await withBoundedRetry(() => params.rebuildSnapshotAndQuote!(), sleep, 3);
      snapshot = rebuilt.snapshot;
      quote = rebuilt.quote;
      quoteContext = rebuilt.quoteContext;
      params.logger?.notify?.('quote rebuilt', { reasonCode: rebuildCheck.reasonCode ?? 'QUOTE_STALE' });
    }

    const epoch = Math.floor(nowUnixMs() / 1000 / 86400);
    const [receiptPda] = deriveReceiptPda({ authority: params.authority, positionMint: snapshot.positionMint, epoch });
    const existingReceipt = params.checkExistingReceipt
      ? await params.checkExistingReceipt(receiptPda)
      : Boolean(await withBoundedRetry(() => fetchReceiptByPda(params.connection, receiptPda), sleep, 3));
    if (existingReceipt) {
      return { refresh: refreshed, errorCode: 'ALREADY_EXECUTED_THIS_EPOCH', errorMessage: 'Execution receipt already exists for canonical epoch' };
    }

    const fetchedAtUnixMs = nowUnixMs();
    let latestBlockhash = await withBoundedRetry(() => params.connection.getLatestBlockhash(), sleep, 3);

    const buildMessage = async (recentBlockhash: string) =>
      buildExitTransaction(snapshot, refreshed.decision.decision === 'TRIGGER_UP' ? 'UP' : ('DOWN' as ExitDirection), {
        authority: params.authority,
        payer: params.authority,
        recentBlockhash,
        computeUnitLimit: 600000,
        computeUnitPriceMicroLamports: 10000,
        conditionalAtaIxs: [],
        removeLiquidityIx: params.removeLiquidityIx,
        collectFeesIx: params.collectFeesIx,
        jupiterSwapIx: params.swapIx,
        buildWsolLifecycleIxs: () => params.wsolLifecycleIxs,
        quote,
        maxSlippageBps: params.slippageBpsCap,
        quoteFreshnessMs: 20_000,
        maxRebuildAttempts: 3,
        nowUnixMs,
        rebuildSnapshotAndQuote: async () => {
          const r = params.rebuildSnapshotAndQuote ? await params.rebuildSnapshotAndQuote() : { snapshot, quote, quoteContext };
          snapshot = r.snapshot;
          quote = r.quote;
          quoteContext = r.quoteContext;
          return { snapshot: r.snapshot, quote: r.quote };
        },
        availableLamports: 50_000_000,
        estimatedNetworkFeeLamports: 20_000,
        estimatedPriorityFeeLamports: 10_000,
        estimatedRentLamports: 2_039_280,
        estimatedAtaCreateLamports: 0,
        feeBufferLamports: 10_000_000,
        attestationHash: params.attestationHash,
        returnVersioned: true,
        simulate: async (message) => {
          const sim = await params.connection.simulateTransaction(new VersionedTransaction(message.compileToV0Message([])));
          return { err: sim.value.err, accountsResolved: true };
        },
      });

    let msg = await buildMessage(latestBlockhash.blockhash);
    const simSummary = 'Simulation passed';
    await params.onSimulationComplete?.(simSummary);

    let sig: string;
    try {
      const refreshedBlockhash = await refreshBlockhashIfNeeded({
        getLatestBlockhash: () => params.connection.getLatestBlockhash(),
        current: { ...latestBlockhash, fetchedAtUnixMs },
        nowUnixMs: nowUnixMs(),
        quoteFreshnessMs: 20_000,
        rebuildMessage: async () => {
          msg = await buildMessage((await params.connection.getLatestBlockhash()).blockhash);
        },
      });
      latestBlockhash = { blockhash: refreshedBlockhash.blockhash, lastValidBlockHeight: refreshedBlockhash.lastValidBlockHeight };
      sig = await params.signAndSend(msg as VersionedTransaction);
    } catch (sendError) {
      const normalized = normalizeSolanaError(sendError);
      if (normalized.code !== 'BLOCKHASH_EXPIRED') throw normalized;
      const refreshedBlockhash = await refreshBlockhashIfNeeded({
        getLatestBlockhash: () => params.connection.getLatestBlockhash(),
        current: { ...latestBlockhash, fetchedAtUnixMs },
        nowUnixMs: nowUnixMs(),
        quoteFreshnessMs: 20_000,
        sendError,
        rebuildMessage: async () => {
          msg = await buildMessage((await params.connection.getLatestBlockhash()).blockhash);
        },
      });
      latestBlockhash = { blockhash: refreshedBlockhash.blockhash, lastValidBlockHeight: refreshedBlockhash.lastValidBlockHeight };
      sig = await params.signAndSend(msg as VersionedTransaction);
    }

    await params.connection.confirmTransaction({ signature: sig, blockhash: latestBlockhash.blockhash, lastValidBlockHeight: latestBlockhash.lastValidBlockHeight }, 'confirmed');

    let receipt = null;
    for (let i = 0; i < 6; i += 1) {
      receipt = await fetchReceiptByPda(params.connection, receiptPda);
      if (receipt) break;
      await sleep(500);
    }

    return {
      refresh: refreshed,
      execution: {
        unsignedTxBuilt: true,
        simulated: true,
        simLogs: [simSummary],
        sendSig: sig,
        receiptPda: receiptPda.toBase58(),
        receiptFetched: Boolean(receipt),
        receiptFields: receipt
          ? `authority=${receipt.authority.toBase58()} positionMint=${receipt.positionMint.toBase58()} epoch=${receipt.epoch} direction=${receipt.direction} attestationHash=${Buffer.from(receipt.attestationHash).toString('hex')} slot=${receipt.slot.toString()} unixTs=${receipt.unixTs.toString()} bump=${receipt.bump}`
          : undefined,
      },
      simSummary,
      txSignature: sig,
      receiptPda: receiptPda.toBase58(),
    };
  } catch (error) {
    const normalized = normalizeSolanaError(error);
    params.logger?.notifyError?.(error, { reasonCode: normalized.code });
    return { errorCode: normalized.code, errorMessage: normalized.message };
  }
}
