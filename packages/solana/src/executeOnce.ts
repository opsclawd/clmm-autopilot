import { evaluateRangeBreak, type Sample } from '@clmm-autopilot/core';
import type { NotificationsAdapter } from '@clmm-autopilot/notifications';
import {
  buildUiModel,
  mapErrorToUi,
  type UiDecision,
  type UiExecution,
  type UiModel,
  type UiQuote,
  type UiSnapshot,
} from '@clmm-autopilot/ui-state';
import { Connection, PublicKey, VersionedTransaction, type TransactionInstruction } from '@solana/web3.js';
import { buildExitTransaction, type ExitDirection, type ExitQuote } from './executionBuilder';
import { loadPositionSnapshot } from './orcaInspector';
import { deriveReceiptPda, fetchReceiptByPda } from './receipt';
import type { CanonicalErrorCode } from './types';

export type RefreshParams = {
  connection: Connection;
  position: PublicKey;
  samples: Sample[];
  slippageBpsCap: number;
  expectedMinOut: string;
  quoteAgeMs: number;
};

export type RefreshResult = {
  snapshot: UiSnapshot;
  decision: UiDecision;
  quote: UiQuote;
  ui: UiModel;
};

export async function refreshPositionDecision(params: RefreshParams): Promise<RefreshResult> {
  const snapshot = await loadPositionSnapshot(params.connection, params.position);
  const uiSnapshot: UiSnapshot = {
    positionAddress: params.position.toBase58(),
    currentTick: snapshot.currentTickIndex,
    lowerTick: snapshot.lowerTickIndex,
    upperTick: snapshot.upperTickIndex,
    inRange: snapshot.inRange,
  };

  const decision = evaluateRangeBreak(
    params.samples,
    { lowerTickIndex: snapshot.lowerTickIndex, upperTickIndex: snapshot.upperTickIndex },
    { requiredConsecutive: 3, cadenceMs: 2000, cooldownMs: 90_000 },
  );

  const uiDecision: UiDecision = {
    decision: decision.action,
    reasonCode: decision.reasonCode,
    samplesUsed: decision.debug.samplesUsed,
    threshold: decision.debug.threshold,
    cooldownRemainingMs: decision.debug.cooldownRemainingMs,
  };

  const uiQuote: UiQuote = {
    slippageBpsCap: params.slippageBpsCap,
    expectedMinOut: params.expectedMinOut,
    quoteAgeMs: params.quoteAgeMs,
  };

  return {
    snapshot: uiSnapshot,
    decision: uiDecision,
    quote: uiQuote,
    ui: buildUiModel({ snapshot: uiSnapshot, decision: uiDecision, quote: uiQuote }),
  };
}

export type ExecuteOnceParams = RefreshParams & {
  authority: PublicKey;
  quote: ExitQuote;
  removeLiquidityIx: TransactionInstruction;
  collectFeesIx: TransactionInstruction;
  swapIx: TransactionInstruction;
  wsolLifecycleIxs: { preSwap: TransactionInstruction[]; postSwap: TransactionInstruction[] };
  attestationHash: Uint8Array;
  signAndSend: (tx: VersionedTransaction) => Promise<string>;
  onSimulationComplete?: (summary: string) => Promise<void> | void;
  notifications?: NotificationsAdapter;
};

export type ExecuteOnceResult = {
  ui: UiModel;
  txSignature?: string;
  receiptPda?: string;
  errorCode?: CanonicalErrorCode;
  simSummary?: string;
};

export async function executeOnce(params: ExecuteOnceParams): Promise<ExecuteOnceResult> {
  try {
    const refreshed = await refreshPositionDecision(params);
    params.notifications?.notify('snapshot fetched', { position: params.position.toBase58() });
    params.notifications?.notify('decision computed', {
      decision: refreshed.decision.decision,
      reasonCode: refreshed.decision.reasonCode,
    });

    if (refreshed.decision.decision === 'HOLD') {
      return {
        ui: buildUiModel({
          ...refreshed.ui,
          lastError: 'DATA_UNAVAILABLE: Execution blocked while decision is HOLD',
        }),
        errorCode: 'DATA_UNAVAILABLE',
      };
    }

    const snapshot = await loadPositionSnapshot(params.connection, params.position);
    const now = Date.now();
    const epoch = Math.floor(now / 1000 / 86400);
    const [receiptPda] = deriveReceiptPda({ authority: params.authority, positionMint: snapshot.positionMint, epoch });

    const msg = await buildExitTransaction(
      snapshot,
      refreshed.decision.decision === 'TRIGGER_UP' ? 'UP' : ('DOWN' as ExitDirection),
      {
        authority: params.authority,
        payer: params.authority,
        recentBlockhash: (await params.connection.getLatestBlockhash()).blockhash,
        computeUnitLimit: 600000,
        computeUnitPriceMicroLamports: 10000,
        conditionalAtaIxs: [],
        removeLiquidityIx: params.removeLiquidityIx,
        collectFeesIx: params.collectFeesIx,
        jupiterSwapIx: params.swapIx,
        buildWsolLifecycleIxs: () => params.wsolLifecycleIxs,
        quote: params.quote,
        maxSlippageBps: params.slippageBpsCap,
        quoteFreshnessMs: 2000,
        maxRebuildAttempts: 3,
        nowUnixMs: () => now,
        rebuildSnapshotAndQuote: async () => ({ snapshot, quote: params.quote }),
        availableLamports: 5_000_000,
        estimatedNetworkFeeLamports: 20_000,
        estimatedPriorityFeeLamports: 10_000,
        estimatedRentLamports: 2_039_280,
        estimatedAtaCreateLamports: 0,
        feeBufferLamports: 10_000,
        attestationHash: params.attestationHash,
        returnVersioned: true,
        simulate: async (message) => {
          const sim = await params.connection.simulateTransaction(new VersionedTransaction(message.compileToV0Message([])));
          return { err: sim.value.err, accountsResolved: true };
        },
      },
    );

    const simSummary = 'Simulation passed';
    params.notifications?.notify('transaction simulated', { summary: simSummary });
    await params.onSimulationComplete?.(simSummary);

    const sig = await params.signAndSend(msg as VersionedTransaction);
    params.notifications?.notify('transaction sent', { signature: sig });

    const receipt = await fetchReceiptByPda(params.connection, receiptPda);
    params.notifications?.notify('receipt fetched', { receiptPda: receiptPda.toBase58(), found: Boolean(receipt) });

    const exec: UiExecution = {
      unsignedTxBuilt: true,
      simulated: true,
      simLogs: [simSummary],
      sendSig: sig,
      receiptPda: receiptPda.toBase58(),
      receiptFetched: Boolean(receipt),
      receiptFields: receipt
        ? `authority=${receipt.authority.toBase58()} positionMint=${receipt.positionMint.toBase58()} epoch=${receipt.epoch} direction=${receipt.direction} attestationHash=${Buffer.from(receipt.attestationHash).toString('hex')} slot=${receipt.slot.toString()} unixTs=${receipt.unixTs.toString()} bump=${receipt.bump}`
        : undefined,
    };

    return {
      ui: buildUiModel({
        snapshot: refreshed.snapshot,
        decision: refreshed.decision,
        quote: refreshed.quote,
        execution: exec,
      }),
      simSummary,
      txSignature: sig,
      receiptPda: receiptPda.toBase58(),
    };
  } catch (error) {
    params.notifications?.notifyError(error);
    const mapped = mapErrorToUi(error);
    return {
      ui: buildUiModel({ lastError: `${mapped.code}: ${mapped.message}` }),
      errorCode: mapped.code,
    };
  }
}
