import { computeAttestationHash, decideSwap, encodeAttestationPayload, evaluateRangeBreak, type AutopilotConfig, type PolicyState, type Sample, unixDaysFromUnixMs } from '@clmm-autopilot/core';
import { Connection, PublicKey, VersionedTransaction, type AddressLookupTableAccount } from '@solana/web3.js';
import { buildExitTransaction, type ExitDirection, type ExitQuote } from './executionBuilder';
import { computeExecutionRequirements } from './requirements';
import { fetchJupiterQuote, fetchJupiterSwapIxs } from './jupiter';
import { normalizeSolanaError } from './errors';
import { loadPositionSnapshot } from './orcaInspector';
import { deriveReceiptPda, DISABLE_RECEIPT_PROGRAM_FOR_TESTING, fetchReceiptByPda } from './receipt';
import { refreshBlockhashIfNeeded, shouldRebuild, withBoundedRetry } from './reliability';
import type { CanonicalErrorCode } from './types';
import { SOL_MINT } from './ata';

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
  quote?: ExitQuote;
  quoteContext?: { quotedAtSlot?: number; quoteTickIndex?: number };
  // Receipt attestation hash (sha256 over canonical bytes) provided by app.
  attestationHash?: Uint8Array;
  attestationPayloadBytes?: Uint8Array;

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

function buildQuoteFromSnapshot(
  snapshot: Awaited<ReturnType<typeof loadPositionSnapshot>>,
  direction: ExitDirection,
  config: AutopilotConfig,
): {
  inputMint: PublicKey;
  outputMint: PublicKey;
  amount: bigint;
  swapDecision: ReturnType<typeof decideSwap>;
} {
  if (!snapshot.removePreview) {
    throw new Error(`Remove preview unavailable (${snapshot.removePreviewReasonCode ?? 'DATA_UNAVAILABLE'})`);
  }
  const tokenAOut = snapshot.removePreview.tokenAOut;
  const tokenBOut = snapshot.removePreview.tokenBOut;
  const inputMint = direction === 'DOWN'
    ? SOL_MINT
    : (snapshot.tokenMintA.equals(SOL_MINT) ? snapshot.tokenMintB : snapshot.tokenMintA);
  const outputMint = direction === 'DOWN'
    ? (snapshot.tokenMintA.equals(SOL_MINT) ? snapshot.tokenMintB : snapshot.tokenMintA)
    : SOL_MINT;
  const amount = direction === 'DOWN'
    ? (snapshot.tokenMintA.equals(SOL_MINT) ? tokenAOut : tokenBOut)
    : (snapshot.tokenMintA.equals(SOL_MINT) ? tokenBOut : tokenAOut);
  const swapDecision = decideSwap(amount, direction, config);
  return { inputMint, outputMint, amount, swapDecision };
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
    const direction = refreshed.decision.decision === 'TRIGGER_UP' ? ('UP' as ExitDirection) : ('DOWN' as ExitDirection);
    let quote = params.quote;
    let quoteContext = params.quoteContext;
    let attestationHash = params.attestationHash;
    let attestationPayloadBytes = params.attestationPayloadBytes;

    const latestSlot = await withBoundedRetry(() => params.connection.getSlot('confirmed'), sleep, params.config.execution);
    const epochSourceMs = nowUnixMs();
    const epoch = unixDaysFromUnixMs(epochSourceMs);

    const assembleFromSnapshot = async (
      sourceSnapshot: Awaited<ReturnType<typeof loadPositionSnapshot>>,
    ): Promise<{
      quote: ExitQuote;
      attestationHash: Uint8Array;
      attestationPayloadBytes: Uint8Array;
      quoteContext: { quotedAtSlot: number; quoteTickIndex: number };
      swapDecision: ReturnType<typeof decideSwap>;
    }> => {
      const { inputMint, outputMint, amount, swapDecision } = buildQuoteFromSnapshot(sourceSnapshot, direction, params.config);
      const builtQuote = swapDecision.execute
        ? await fetchJupiterQuote({
            inputMint,
            outputMint,
            amount,
            slippageBps: params.config.execution.slippageBpsCap,
          })
        : {
            inputMint,
            outputMint,
            inAmount: amount,
            outAmount: BigInt(0),
            slippageBps: params.config.execution.slippageBpsCap,
            quotedAtUnixMs: nowUnixMs(),
          };
      const attestationInput = {
        cluster: params.config.cluster,
        authority: params.authority.toBase58(),
        position: sourceSnapshot.position.toBase58(),
        positionMint: sourceSnapshot.positionMint.toBase58(),
        whirlpool: sourceSnapshot.whirlpool.toBase58(),
        epoch,
        direction: direction === 'UP' ? (1 as const) : (0 as const),
        tickCurrent: sourceSnapshot.currentTickIndex,
        lowerTickIndex: sourceSnapshot.lowerTickIndex,
        upperTickIndex: sourceSnapshot.upperTickIndex,
        slippageBpsCap: params.config.execution.slippageBpsCap,
        quoteInputMint: builtQuote.inputMint.toBase58(),
        quoteOutputMint: builtQuote.outputMint.toBase58(),
        quoteInAmount: builtQuote.inAmount,
        quoteMinOutAmount: builtQuote.outAmount,
        quoteQuotedAtUnixMs: BigInt(builtQuote.quotedAtUnixMs),
        swapPlanned: 1,
        swapExecuted: swapDecision.execute ? 1 : 0,
        swapReasonCode: swapDecision.reasonCode,
      };
      return {
        quote: builtQuote,
        attestationHash: computeAttestationHash(attestationInput),
        attestationPayloadBytes: encodeAttestationPayload(attestationInput),
        quoteContext: { quotedAtSlot: latestSlot, quoteTickIndex: sourceSnapshot.currentTickIndex },
        swapDecision,
      };
    };

    if (!quote || !attestationHash || !attestationPayloadBytes) {
      const assembled = await withBoundedRetry(() => assembleFromSnapshot(snapshot), sleep, params.config.execution);
      quote = assembled.quote;
      attestationHash = assembled.attestationHash;
      attestationPayloadBytes = assembled.attestationPayloadBytes;
      quoteContext = assembled.quoteContext;
      params.logger?.notify?.('quote assembled');
    }

    const rebuildCheck = shouldRebuild(
      {
        quotedAtUnixMs: quote!.quotedAtUnixMs,
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
      if (params.rebuildSnapshotAndQuote) {
        const rebuilt = await withBoundedRetry(() => params.rebuildSnapshotAndQuote!(), sleep, params.config.execution);
        snapshot = rebuilt.snapshot;
        quote = rebuilt.quote;
        quoteContext = rebuilt.quoteContext;
      } else {
        snapshot = await withBoundedRetry(
          () => loadPositionSnapshot(params.connection, params.position, params.config.cluster),
          sleep,
          params.config.execution,
        );
        const rebuilt = await withBoundedRetry(() => assembleFromSnapshot(snapshot), sleep, params.config.execution);
        quote = rebuilt.quote;
        quoteContext = rebuilt.quoteContext;
        attestationHash = rebuilt.attestationHash;
        attestationPayloadBytes = rebuilt.attestationPayloadBytes;
      }
      params.logger?.notify?.('quote rebuilt', { reasonCode: rebuildCheck.reasonCode ?? 'QUOTE_STALE' });
    }

    const receiptPda = DISABLE_RECEIPT_PROGRAM_FOR_TESTING
      ? null
      : deriveReceiptPda({ authority: params.authority, positionMint: snapshot.positionMint, epoch })[0];
    if (!DISABLE_RECEIPT_PROGRAM_FOR_TESTING && receiptPda) {
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
    }

    const availableLamports = await withBoundedRetry(
      () => params.connection.getBalance(params.authority),
      sleep,
      params.config.execution,
    );

    const fetchedAtUnixMs = nowUnixMs();
    let latestBlockhash = await withBoundedRetry(() => params.connection.getLatestBlockhash(), sleep, params.config.execution);

    const buildTx = async (recentBlockhash: string) => {
      let lookupTableAccounts: AddressLookupTableAccount[] = [];
      let cachedSwap: Awaited<ReturnType<typeof fetchJupiterSwapIxs>> | null = null;

      const swapDecision = decideSwap(quote!.inAmount, direction, params.config);

      if (swapDecision.execute) {
        const buildSwapIxs = params.buildJupiterSwapIxs ?? fetchJupiterSwapIxs;
        cachedSwap = await buildSwapIxs({ quote: quote! as any, userPublicKey: params.authority, wrapAndUnwrapSol: false });
        lookupTableAccounts = await loadLookupTables(params.connection, cachedSwap.lookupTableAddresses);
      }

      return buildExitTransaction(snapshot, direction, {
        authority: params.authority,
        payer: params.authority,
        recentBlockhash,
        computeUnitLimit: params.config.execution.computeUnitLimit,
        computeUnitPriceMicroLamports: params.config.execution.computeUnitPriceMicroLamports,
        quote: quote!,
        slippageBpsCap: params.config.execution.slippageBpsCap,
        quoteFreshnessMs: params.config.execution.quoteFreshnessMs,
        nowUnixMs,
        receiptEpochUnixMs: epochSourceMs,
        minSolLamportsToSwap: params.config.execution.minSolLamportsToSwap,
        minUsdcMinorToSwap: params.config.execution.minUsdcMinorToSwap,
        availableLamports,
        requirements: await computeExecutionRequirements({
          connection: params.connection,
          snapshot,
          quote: quote!,
          authority: params.authority,
          payer: params.authority,
          txFeeLamports: params.config.execution.txFeeLamports,
          computeUnitLimit: params.config.execution.computeUnitLimit,
          computeUnitPriceMicroLamports: params.config.execution.computeUnitPriceMicroLamports,
          bufferLamports: params.config.execution.feeBufferLamports,
        }),
        attestationHash: attestationHash!,
        attestationPayloadBytes: attestationPayloadBytes!,
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
        buildJupiterSwapIxs: async () => {
          if (!cachedSwap) {
            throw new Error('buildJupiterSwapIxs should not be called for dust-skip executions');
          }
          return cachedSwap;
        },
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
    if (!DISABLE_RECEIPT_PROGRAM_FOR_TESTING && receiptPda) {
      for (let i = 0; i < params.config.execution.receiptPollMaxAttempts; i += 1) {
        receipt = await fetchReceiptByPda(params.connection, receiptPda);
        if (receipt) break;
        await sleep(params.config.execution.receiptPollIntervalMs);
      }
    }

    return {
      status: 'EXECUTED',
      refresh: refreshed,
      execution: {
        unsignedTxBuilt: true,
        simulated: true,
        simLogs: [simSummary],
        sendSig: sig,
        receiptPda: receiptPda?.toBase58(),
        receiptFetched: Boolean(receipt),
        receiptFields: receipt
          ? `authority=${receipt.authority.toBase58()} positionMint=${receipt.positionMint.toBase58()} epoch=${receipt.epoch} direction=${receipt.direction} attestationHash=${Buffer.from(receipt.attestationHash).toString('hex')} slot=${receipt.slot.toString()} unixTs=${receipt.unixTs.toString()} bump=${receipt.bump}`
          : undefined,
      },
      simSummary,
      txSignature: sig,
      receiptPda: receiptPda?.toBase58(),
    };
  } catch (error) {
    const normalized = normalizeSolanaError(error);
    params.logger?.notifyError?.(error, { reasonCode: normalized.code });
    return { status: 'ERROR', errorCode: normalized.code, errorMessage: normalized.message, errorDebug: normalized.debug };
  }
}
