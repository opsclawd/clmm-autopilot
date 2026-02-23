import { evaluateRangeBreak, type Sample } from '@clmm-autopilot/core';
import { buildUiModel, mapErrorToUi, type UiDecision, type UiExecution, type UiModel, type UiQuote, type UiSnapshot } from '@clmm-autopilot/ui-state';
import { Connection, PublicKey, VersionedTransaction, type TransactionInstruction } from '@solana/web3.js';
import { buildExitTransaction, type ExitDirection, type ExitQuote } from './executionBuilder';
import { deriveReceiptPda, fetchReceiptByPda } from './receipt';
import { loadPositionSnapshot } from './orcaInspector';

export type ExecuteOnceParams = {
  connection: Connection;
  authority: PublicKey;
  position: PublicKey;
  samples: Sample[];
  quote: ExitQuote;
  slippageBpsCap: number;
  expectedMinOut: string;
  quoteAgeMs: number;
  removeLiquidityIx: TransactionInstruction;
  collectFeesIx: TransactionInstruction;
  swapIx: TransactionInstruction;
  wsolLifecycleIxs: { preSwap: TransactionInstruction[]; postSwap: TransactionInstruction[] };
  attestationHash: Uint8Array;
  signAndSend: (tx: VersionedTransaction) => Promise<string>;
};

export type ExecuteOnceResult = {
  ui: UiModel;
  txSignature?: string;
  receiptPda?: string;
};

export async function executeOnce(params: ExecuteOnceParams): Promise<ExecuteOnceResult> {
  try {
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

    if (decision.action === 'HOLD') {
      const mapped = mapErrorToUi({ code: 'DATA_UNAVAILABLE' });
      return { ui: buildUiModel({ snapshot: uiSnapshot, decision: uiDecision, quote: uiQuote, lastError: `${mapped.title}: HOLD` }) };
    }

    const now = Date.now();
    const epoch = Math.floor(now / 1000 / 86400);
    const [receiptPda] = deriveReceiptPda({ authority: params.authority, positionMint: snapshot.positionMint, epoch });

    const msg = await buildExitTransaction(snapshot, decision.action === 'TRIGGER_UP' ? 'UP' : ('DOWN' as ExitDirection), {
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
    });

    const sig = await params.signAndSend(msg as VersionedTransaction);
    const receipt = await fetchReceiptByPda(params.connection, receiptPda);
    const exec: UiExecution = {
      unsignedTxBuilt: true,
      simulated: true,
      sendSig: sig,
      receiptPda: receiptPda.toBase58(),
      receiptFetched: Boolean(receipt),
      receiptFields: receipt
        ? `authority=${receipt.authority.toBase58()} positionMint=${receipt.positionMint.toBase58()} epoch=${receipt.epoch} direction=${receipt.direction} attestationHash=${Buffer.from(receipt.attestationHash).toString('hex')} slot=${receipt.slot.toString()} unixTs=${receipt.unixTs.toString()} bump=${receipt.bump}`
        : undefined,
    };

    return {
      ui: buildUiModel({ snapshot: uiSnapshot, decision: uiDecision, quote: uiQuote, execution: exec }),
      txSignature: sig,
      receiptPda: receiptPda.toBase58(),
    };
  } catch (error) {
    const mapped = mapErrorToUi(error);
    return { ui: buildUiModel({ lastError: `${mapped.title}: ${mapped.message}` }) };
  }
}
