import { evaluateRangeBreak, type AutopilotConfig, type PolicyState, type Sample, unixDaysFromUnixMs } from '@clmm-autopilot/core';
import { Connection, PublicKey, VersionedTransaction, type AddressLookupTableAccount } from '@solana/web3.js';
import { buildExitTransaction, type ExitDirection, type ExitQuote } from './executionBuilder';
import { computeExecutionRequirements } from './requirements';
import { fetchJupiterSwapIxs } from './jupiter';
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
  config: AutopilotConfig;
  policyState?: PolicyState;

  // UI-only quote diagnostics (not used by core policy).
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
    pairLabel: string;
    pairValid: boolean;
  };
  decision: {
    decision: 'HOLD' | 'TRIGGER_DOWN' | 'TRIGGER_UP';
    reasonCode: string;
    samplesUsed: number;
    threshold: number;
    cooldownRemainingMs: number;
    nextState: PolicyState;
  };
  quote: { slippageBpsCap: number; expectedMinOut: string; quoteAgeMs: number };
};

export async function refreshPositionDecision(params: RefreshParams): Promise<RefreshResult> {
  const snapshot = await loadPositionSnapshot(params.connection, params.position, params.config.cluster);
  const decision = evaluateRangeBreak(
    params.samples,
    { lowerTickIndex: snapshot.lowerTickIndex, upperTickIndex: snapshot.upperTickIndex },
    params.config.policy,
    params.policyState ?? {},
  );

  return {
    snapshot: {
      positionAddress: params.position.toBase58(),
      currentTick: snapshot.currentTickIndex,
      lowerTick: snapshot.lowerTickIndex,
      upperTick: snapshot.upperTickIndex,
      inRange: snapshot.inRange,
      pairLabel: snapshot.pairLabel,
      pairValid: snapshot.pairValid,
    },
    decision: {
      decision: decision.action,
      reasonCode: decision.reasonCode,
      samplesUsed: decision.debug.samplesUsed,
      threshold: decision.debug.threshold,
      cooldownRemainingMs: decision.debug.cooldownRemainingMs,
      nextState: decision.nextState,
    },
    quote: {
      slippageBpsCap: params.config.execution.slippageBpsCap,
      expectedMinOut: params.expectedMinOut,
      quoteAgeMs: params.quoteAgeMs,
    },
  };
}

export type ExecuteOnceParams = RefreshParams & {
  authority: PublicKey;
  quote: ExitQuote;
  quoteContext?: { quotedAtSlot?: number; quoteTickIndex?: number };
  // Receipt attestation hash (sha256 over canonical bytes) provided by app.
  attestationHash: Uint8Array;
  attestationPayloadBytes: Uint8Array;

  signAndSend: (tx: VersionedTransaction) => Promise<string>;

  // Optional dependency injection for deterministic tests.
  buildJupiterSwapIxs?: typeof fetchJupiterSwapIxs;

  rebuildSnapshotAndQuote?: () => Promise<{
    snapshot: Awaited<ReturnType<typeof loadPositionSnapshot>>;
    quote: ExitQuote;
    quoteContext?: { quotedAtSlot?: number; quoteTickIndex?: number };
  }>;
  sleep?: (ms: number) => Promise<void>;
  nowUnixMs?: () => number;
  checkExistingReceipt?: (receiptPda: PublicKey) => Promise<boolean>;
  onSimulationComplete?: (summary: string) => Promise<void> | void;
  logger?: Logger;
};

export type ExecuteOnceResult = {
  status: 'HOLD' | 'EXECUTED' | 'ERROR';
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
  errorDebug?: unknown;
  simSummary?: string;
};

async function loadLookupTables(connection: Connection, addresses: PublicKey[]): Promise<AddressLookupTableAccount[]> {
  const out: AddressLookupTableAccount[] = [];
  for (const addr of addresses) {
    const res = await connection.getAddressLookupTable(addr);
    if (res.value) out.push(res.value);
  }
  return out;
}

export async function executeOnce(params: ExecuteOnceParams): Promise<ExecuteOnceResult> {
  const sleep = params.sleep ?? (async (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const nowUnixMs = params.nowUnixMs ?? (() => Date.now());

  try {
    const refreshed = await withBoundedRetry(() => refreshPositionDecision(params), sleep, params.config.execution);
    params.logger?.notify?.('snapshot fetched', { position: params.position.toBase58() });

    if (refreshed.decision.decision === 'HOLD') {
      return { status: 'HOLD', refresh: refreshed };
    }

    let snapshot = await withBoundedRetry(
      () => loadPositionSnapshot(params.connection, params.position, params.config.cluster),
      sleep,
      params.config.execution,
    );
    let quote = params.quote;
    let quoteContext = params.quoteContext;

    const latestSlot = await withBoundedRetry(() => params.connection.getSlot('confirmed'), sleep, params.config.execution);

    const rebuildCheck = shouldRebuild(
      {
        quotedAtUnixMs: quote.quotedAtUnixMs,
        quotedAtSlot: quoteContext?.quotedAtSlot,
        quoteTickIndex: quoteContext?.quoteTickIndex,
      },
      snapshot,
      {
        nowUnixMs: nowUnixMs(),
        latestSlot,
        quoteFreshnessMs: params.config.execution.quoteFreshnessMs,
        quoteFreshnessSlots: params.config.execution.quoteFreshnessSlots,
        rebuildTickDelta: params.config.execution.rebuildTickDelta,
      },
    );

    if (rebuildCheck.rebuild) {
      if (!params.rebuildSnapshotAndQuote) {
        return {
          status: 'ERROR',
          refresh: refreshed,
          errorCode: 'QUOTE_STALE',
          errorMessage: `Rebuild required: ${rebuildCheck.reasonCode}`,
        };
      }
      const rebuilt = await withBoundedRetry(() => params.rebuildSnapshotAndQuote!(), sleep, params.config.execution);
      snapshot = rebuilt.snapshot;
      quote = rebuilt.quote;
      quoteContext = rebuilt.quoteContext;
      params.logger?.notify?.('quote rebuilt', { reasonCode: rebuildCheck.reasonCode ?? 'QUOTE_STALE' });
    }

    // Dust thresholds (avoid building/simulating/sending meaningless swaps).
    const isSolInput = quote.inputMint.toBase58() === 'So11111111111111111111111111111111111111112';
    if (isSolInput && quote.inAmount < BigInt(params.config.execution.minSolLamportsToSwap)) {
      return {
        status: 'HOLD',
        refresh: refreshed,
      };
    }
    if (!isSolInput && quote.inAmount < BigInt(params.config.execution.minUsdcMinorToSwap)) {
      return {
        status: 'HOLD',
        refresh: refreshed,
      };
    }

    const epochSourceMs = nowUnixMs();
    const epoch = unixDaysFromUnixMs(epochSourceMs);
    const [receiptPda] = deriveReceiptPda({ authority: params.authority, positionMint: snapshot.positionMint, epoch });
    const existingReceipt = params.checkExistingReceipt
      ? await params.checkExistingReceipt(receiptPda)
      : Boolean(await withBoundedRetry(() => fetchReceiptByPda(params.connection, receiptPda), sleep, params.config.execution));
    if (existingReceipt) {
      return {
        status: 'ERROR',
        refresh: refreshed,
        errorCode: 'ALREADY_EXECUTED_THIS_EPOCH',
        errorMessage: 'Execution receipt already exists for canonical epoch',
      };
    }

    const availableLamports = await withBoundedRetry(
      () => params.connection.getBalance(params.authority),
      sleep,
      params.config.execution,
    );

    const fetchedAtUnixMs = nowUnixMs();
    let latestBlockhash = await withBoundedRetry(() => params.connection.getLatestBlockhash(), sleep, params.config.execution);

    const buildTx = async (recentBlockhash: string) => {
      const buildSwapIxs = params.buildJupiterSwapIxs ?? fetchJupiterSwapIxs;
      const swap = await buildSwapIxs({ quote: quote as any, userPublicKey: params.authority, wrapAndUnwrapSol: false });
      const lookupTableAccounts = await loadLookupTables(params.connection, swap.lookupTableAddresses);

      return buildExitTransaction(snapshot, refreshed.decision.decision === 'TRIGGER_UP' ? 'UP' : ('DOWN' as ExitDirection), {
        authority: params.authority,
        payer: params.authority,
        recentBlockhash,
        computeUnitLimit: params.config.execution.computeUnitLimit,
        computeUnitPriceMicroLamports: params.config.execution.computeUnitPriceMicroLamports,
        quote,
        slippageBpsCap: params.config.execution.slippageBpsCap,
        quoteFreshnessMs: params.config.execution.quoteFreshnessMs,
        nowUnixMs,
        receiptEpochUnixMs: epochSourceMs,
        availableLamports,
        requirements: await computeExecutionRequirements({
          connection: params.connection,
          snapshot,
          quote,
          authority: params.authority,
          payer: params.authority,
          txFeeLamports: params.config.execution.txFeeLamports,
          computeUnitLimit: params.config.execution.computeUnitLimit,
          computeUnitPriceMicroLamports: params.config.execution.computeUnitPriceMicroLamports,
          bufferLamports: params.config.execution.feeBufferLamports,
        }),
        attestationHash: params.attestationHash,
        attestationPayloadBytes: params.attestationPayloadBytes,
        lookupTableAccounts,
        returnVersioned: true,
        // Phase-1: simulate must succeed before prompting wallet.
        simulate: async (tx) => {
          const sim = await params.connection.simulateTransaction(tx);
          return {
            err: sim.value.err,
            logs: sim.value.logs ?? undefined,
            unitsConsumed: sim.value.unitsConsumed ?? undefined,
            innerInstructions: sim.value.innerInstructions ?? undefined,
            returnData: sim.value.returnData ?? undefined,
          };
        },
        // Provide cached Jupiter swap so ordering is stable.
        buildJupiterSwapIxs: async () => swap,
      });
    };

    let msg = (await buildTx(latestBlockhash.blockhash)) as VersionedTransaction;
    const simSummary = 'Simulation passed';
    await params.onSimulationComplete?.(simSummary);

    let sig: string;
    try {
      const refreshedBlockhash = await refreshBlockhashIfNeeded({
        getLatestBlockhash: () => params.connection.getLatestBlockhash(),
        current: { ...latestBlockhash, fetchedAtUnixMs },
        nowUnixMs: nowUnixMs(),
        quoteFreshnessMs: params.config.execution.quoteFreshnessMs,
        rebuildMessage: async () => {
          msg = (await buildTx((await params.connection.getLatestBlockhash()).blockhash)) as VersionedTransaction;
        },
      });
      latestBlockhash = {
        blockhash: refreshedBlockhash.blockhash,
        lastValidBlockHeight: refreshedBlockhash.lastValidBlockHeight,
      };
      sig = await params.signAndSend(msg);
    } catch (sendError) {
      const normalized = normalizeSolanaError(sendError);
      if (normalized.code !== 'BLOCKHASH_EXPIRED') throw normalized;
      const refreshedBlockhash = await refreshBlockhashIfNeeded({
        getLatestBlockhash: () => params.connection.getLatestBlockhash(),
        current: { ...latestBlockhash, fetchedAtUnixMs },
        nowUnixMs: nowUnixMs(),
        quoteFreshnessMs: params.config.execution.quoteFreshnessMs,
        sendError,
        rebuildMessage: async () => {
          msg = (await buildTx((await params.connection.getLatestBlockhash()).blockhash)) as VersionedTransaction;
        },
      });
      latestBlockhash = {
        blockhash: refreshedBlockhash.blockhash,
        lastValidBlockHeight: refreshedBlockhash.lastValidBlockHeight,
      };
      sig = await params.signAndSend(msg);
    }

    await params.connection.confirmTransaction(
      {
        signature: sig,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      },
      'confirmed',
    );

    let receipt = null;
    for (let i = 0; i < 6; i += 1) {
      receipt = await fetchReceiptByPda(params.connection, receiptPda);
      if (receipt) break;
      await sleep(500);
    }

    return {
      status: 'EXECUTED',
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
    return { status: 'ERROR', errorCode: normalized.code, errorMessage: normalized.message, errorDebug: normalized.debug };
  }
}
