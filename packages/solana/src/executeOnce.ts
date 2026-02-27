import {
  computeAttestationHash,
  decideSwap,
  encodeAttestationPayload,
  evaluateRangeBreak,
  unixDaysFromUnixMs,
  type AutopilotConfig,
  type PolicyState,
  type Sample,
  type SwapPlan,
  type SwapQuote,
} from '@clmm-autopilot/core';
import { Connection, PublicKey, VersionedTransaction, type AddressLookupTableAccount, type TransactionInstruction } from '@solana/web3.js';
import { buildExitTransaction, type ExitDirection } from './executionBuilder';
import { computeExecutionRequirements } from './requirements';
import { normalizeSolanaError } from './errors';
import { loadPositionSnapshot } from './orcaInspector';
import { deriveReceiptPda, DISABLE_RECEIPT_PROGRAM_FOR_TESTING, fetchReceiptByPda } from './receipt';
import { refreshBlockhashIfNeeded, shouldRebuild, withBoundedRetry } from './reliability';
import type { CanonicalErrorCode } from './types';
import { SOL_MINT } from './ata';
import { deriveSwapTickArrays } from './swap/tickArrays';
import { getSwapAdapter } from './swap/registry';
import type { SolanaSwapContext } from './swap/types';

type Logger = {
  notify?: (info: string, context?: Record<string, string | number | boolean>) => void;
  notifyError?: (err: unknown, context?: Record<string, string | number | boolean>) => void;
};

const ZERO_PUBKEY = '11111111111111111111111111111111';

export type RefreshParams = {
  connection: Connection;
  position: PublicKey;
  samples: Sample[];
  config: AutopilotConfig;
  policyState?: PolicyState;
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
  // Backward-compatible optional inputs (ignored by planner path when omitted).
  quote?: unknown;
  quoteContext?: { quotedAtSlot?: number; quoteTickIndex?: number };
  attestationHash?: Uint8Array;
  attestationPayloadBytes?: Uint8Array;
  buildJupiterSwapIxs?: unknown;
  rebuildSnapshotAndQuote?: unknown;
  signAndSend: (tx: VersionedTransaction) => Promise<string>;
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

async function loadLookupTables(_connection: Connection, _addresses: PublicKey[]): Promise<AddressLookupTableAccount[]> {
  const out: AddressLookupTableAccount[] = [];
  for (const addr of _addresses) {
    const res = await _connection.getAddressLookupTable(addr);
    if (res.value) out.push(res.value);
  }
  return out;
}

function buildSwapInput(
  snapshot: Awaited<ReturnType<typeof loadPositionSnapshot>>,
  direction: ExitDirection,
): {
  inputMint: PublicKey;
  outputMint: PublicKey;
  amount: bigint;
  aToB: boolean;
} {
  if (!snapshot.removePreview) {
    throw new Error(`Remove preview unavailable (${snapshot.removePreviewReasonCode ?? 'DATA_UNAVAILABLE'})`);
  }
  const tokenAOut = snapshot.removePreview.tokenAOut;
  const tokenBOut = snapshot.removePreview.tokenBOut;

  if (direction === 'DOWN') {
    const inputMint = SOL_MINT;
    const outputMint = snapshot.tokenMintA.equals(SOL_MINT) ? snapshot.tokenMintB : snapshot.tokenMintA;
    const amount = snapshot.tokenMintA.equals(SOL_MINT) ? tokenAOut : tokenBOut;
    return { inputMint, outputMint, amount, aToB: inputMint.equals(snapshot.tokenMintA) };
  }

  const inputMint = snapshot.tokenMintA.equals(SOL_MINT) ? snapshot.tokenMintB : snapshot.tokenMintA;
  const outputMint = SOL_MINT;
  const amount = snapshot.tokenMintA.equals(SOL_MINT) ? tokenBOut : tokenAOut;
  return { inputMint, outputMint, amount, aToB: inputMint.equals(snapshot.tokenMintA) };
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

    const latestSlot = await withBoundedRetry(() => params.connection.getSlot('confirmed'), sleep, params.config.execution);
    const epochSourceMs = nowUnixMs();
    const epoch = unixDaysFromUnixMs(epochSourceMs);

    const buildPlan = async (
      sourceSnapshot: Awaited<ReturnType<typeof loadPositionSnapshot>>,
    ): Promise<{
      plan: SwapPlan;
      swapIxs: ReturnType<typeof Array.prototype.slice>;
      lookupTableAddresses: PublicKey[];
      quoteTickIndex: number;
      quotedAtUnixMs: number;
    }> => {
      const suppliedQuote = params.quote as
        | { inputMint: PublicKey; outputMint: PublicKey; inAmount: bigint; outAmount: bigint; quotedAtUnixMs: number }
        | undefined;
      const { inputMint, outputMint, amount, aToB } = suppliedQuote
        ? {
            inputMint: suppliedQuote.inputMint,
            outputMint: suppliedQuote.outputMint,
            amount: suppliedQuote.inAmount,
            aToB: suppliedQuote.inputMint.equals(sourceSnapshot.tokenMintA),
          }
        : buildSwapInput(sourceSnapshot, direction);
      const swapDecision = decideSwap(amount, direction, params.config);

      const tickArrays = deriveSwapTickArrays({
        whirlpool: sourceSnapshot.whirlpool,
        tickSpacing: sourceSnapshot.tickSpacing,
        tickCurrentIndex: sourceSnapshot.currentTickIndex,
        aToB,
      });

      const swapContext: SolanaSwapContext = {
        connection: params.connection,
        whirlpool: sourceSnapshot.whirlpool,
        tickSpacing: sourceSnapshot.tickSpacing,
        tickCurrentIndex: sourceSnapshot.currentTickIndex,
        tickArrays,
        tokenMintA: sourceSnapshot.tokenMintA,
        tokenMintB: sourceSnapshot.tokenMintB,
        tokenVaultA: sourceSnapshot.tokenVaultA,
        tokenVaultB: sourceSnapshot.tokenVaultB,
        tokenProgramA: sourceSnapshot.tokenProgramA,
        tokenProgramB: sourceSnapshot.tokenProgramB,
        aToB,
      };

      const router = params.config.execution.swapRouter;
      let planQuote: SwapQuote = {
        router,
        inMint: ZERO_PUBKEY,
        outMint: ZERO_PUBKEY,
        swapInAmount: BigInt(0),
        swapMinOutAmount: BigInt(0),
        slippageBpsCap: params.config.execution.slippageBpsCap,
        quotedAtUnixSec: 0,
      };
      let swapIxs: TransactionInstruction[] = [];
      let lookupTableAddresses: PublicKey[] = [];
      let swapPlanned = false;
      let swapSkipReason: 'NONE' | 'DUST' | 'ROUTER_DISABLED' = 'NONE';

      if (!swapDecision.execute) {
        swapSkipReason = 'DUST';
      } else if (router === 'noop') {
        swapSkipReason = 'ROUTER_DISABLED';
      } else {
        const adapter = getSwapAdapter(router, params.config.cluster);
        if (suppliedQuote) {
          planQuote = {
            router,
            inMint: suppliedQuote.inputMint.toBase58(),
            outMint: suppliedQuote.outputMint.toBase58(),
            swapInAmount: suppliedQuote.inAmount,
            swapMinOutAmount: suppliedQuote.outAmount,
            slippageBpsCap: params.config.execution.slippageBpsCap,
            quotedAtUnixSec: Math.floor(suppliedQuote.quotedAtUnixMs / 1000),
          };
        } else {
          planQuote = await adapter.getQuote({
            cluster: params.config.cluster,
            inMint: inputMint.toBase58(),
            outMint: outputMint.toBase58(),
            swapInAmount: amount,
            slippageBpsCap: params.config.execution.slippageBpsCap,
            quoteFreshnessSec: params.config.execution.quoteFreshnessSec,
            swapContext,
          });
        }
        const swapBuild = await adapter.buildSwapIxs(planQuote, params.authority, swapContext);
        swapIxs = swapBuild.instructions;
        lookupTableAddresses = swapBuild.lookupTableAddresses;
        swapPlanned = true;
      }

      return {
        plan: {
          swapPlanned,
          swapSkipReason,
          swapRouter: router,
          quote: planQuote,
        },
        swapIxs,
        lookupTableAddresses,
        quoteTickIndex: sourceSnapshot.currentTickIndex,
        quotedAtUnixMs: planQuote.quotedAtUnixSec * 1000,
      };
    };

    let assembled = await withBoundedRetry(() => buildPlan(snapshot), sleep, params.config.execution);

    const rebuildCheck = shouldRebuild(
      {
        quotedAtUnixMs: assembled.quotedAtUnixMs,
        quotedAtSlot: latestSlot,
        quoteTickIndex: assembled.quoteTickIndex,
      },
      snapshot,
      {
        nowUnixMs: nowUnixMs(),
        latestSlot,
        quoteFreshnessMs: params.config.execution.quoteFreshnessSec * 1000,
        quoteFreshnessSlots: params.config.execution.quoteFreshnessSlots,
        rebuildTickDelta: params.config.execution.rebuildTickDelta,
      },
    );

    if (rebuildCheck.rebuild) {
      snapshot = await withBoundedRetry(
        () => loadPositionSnapshot(params.connection, params.position, params.config.cluster),
        sleep,
        params.config.execution,
      );
      assembled = await withBoundedRetry(() => buildPlan(snapshot), sleep, params.config.execution);
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

    const attestationInput = {
      attestationVersion: 2,
      cluster: params.config.cluster,
      authority: params.authority.toBase58(),
      position: snapshot.position.toBase58(),
      positionMint: snapshot.positionMint.toBase58(),
      whirlpool: snapshot.whirlpool.toBase58(),
      epoch,
      direction: direction === 'UP' ? (1 as const) : (0 as const),
      tickCurrent: snapshot.currentTickIndex,
      lowerTickIndex: snapshot.lowerTickIndex,
      upperTickIndex: snapshot.upperTickIndex,
      slippageBpsCap: params.config.execution.slippageBpsCap,
      quoteInputMint: assembled.plan.quote.inMint,
      quoteOutputMint: assembled.plan.quote.outMint,
      quoteInAmount: assembled.plan.quote.swapInAmount,
      quoteMinOutAmount: assembled.plan.quote.swapMinOutAmount,
      quoteQuotedAtUnixSec: assembled.plan.quote.quotedAtUnixSec,
      swapPlanned: assembled.plan.swapPlanned ? 1 : 0,
      swapSkipReason: assembled.plan.swapSkipReason,
      swapRouter: assembled.plan.swapRouter,
    };

    const attestationHash = params.attestationHash ?? computeAttestationHash(attestationInput);
    const attestationPayloadBytes = params.attestationPayloadBytes ?? encodeAttestationPayload(attestationInput);

    const availableLamports = await withBoundedRetry(() => params.connection.getBalance(params.authority), sleep, params.config.execution);

    const fetchedAtUnixMs = nowUnixMs();
    let latestBlockhash = await withBoundedRetry(() => params.connection.getLatestBlockhash(), sleep, params.config.execution);

    const buildTx = async (recentBlockhash: string) => {
      const lookupTableAccounts: AddressLookupTableAccount[] = await loadLookupTables(params.connection, assembled.lookupTableAddresses);
      return buildExitTransaction(snapshot, direction, {
        authority: params.authority,
        payer: params.authority,
        recentBlockhash,
        computeUnitLimit: params.config.execution.computeUnitLimit,
        computeUnitPriceMicroLamports: params.config.execution.computeUnitPriceMicroLamports,
        quote: {
          inputMint: new PublicKey(assembled.plan.swapPlanned ? assembled.plan.quote.inMint : snapshot.tokenMintA.toBase58()),
          outputMint: new PublicKey(assembled.plan.swapPlanned ? assembled.plan.quote.outMint : snapshot.tokenMintB.toBase58()),
          inAmount: assembled.plan.swapPlanned ? assembled.plan.quote.swapInAmount : BigInt(0),
          outAmount: assembled.plan.swapPlanned ? assembled.plan.quote.swapMinOutAmount : BigInt(0),
          slippageBps: params.config.execution.slippageBpsCap,
          quotedAtUnixMs: assembled.plan.swapPlanned ? assembled.plan.quote.quotedAtUnixSec * 1000 : 0,
        },
        slippageBpsCap: params.config.execution.slippageBpsCap,
        quoteFreshnessMs: params.config.execution.quoteFreshnessSec * 1000,
        nowUnixMs,
        minSolLamportsToSwap: params.config.execution.minSolLamportsToSwap,
        minUsdcMinorToSwap: params.config.execution.minUsdcMinorToSwap,
        swapPlan: assembled.plan,
        quoteFreshnessSec: params.config.execution.quoteFreshnessSec,
        nowUnixSec: () => Math.floor(nowUnixMs() / 1000),
        receiptEpochUnixMs: epochSourceMs,
        availableLamports,
        requirements: await computeExecutionRequirements({
          connection: params.connection,
          snapshot,
          quote: {
            inputMint: new PublicKey(assembled.plan.swapPlanned ? assembled.plan.quote.inMint : snapshot.tokenMintA.toBase58()),
            outputMint: new PublicKey(assembled.plan.swapPlanned ? assembled.plan.quote.outMint : snapshot.tokenMintB.toBase58()),
          },
          swapPlanned: assembled.plan.swapPlanned,
          authority: params.authority,
          payer: params.authority,
          txFeeLamports: params.config.execution.txFeeLamports,
          computeUnitLimit: params.config.execution.computeUnitLimit,
          computeUnitPriceMicroLamports: params.config.execution.computeUnitPriceMicroLamports,
          bufferLamports: params.config.execution.feeBufferLamports,
        }),
        attestationHash,
        attestationPayloadBytes,
        lookupTableAccounts,
        returnVersioned: true,
        swapIxs: assembled.swapIxs,
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
        quoteFreshnessMs: params.config.execution.quoteFreshnessSec * 1000,
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
        quoteFreshnessMs: params.config.execution.quoteFreshnessSec * 1000,
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
