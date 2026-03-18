import {
  computeAttestationHash,
  decideSwap,
  deriveRuntimeModeFromExecutionMode,
  encodeAttestationPayload,
  evaluateRangeBreak,
  unixDaysFromUnixMs,
  type AutopilotConfig,
  type ExecutionMode,
  type PolicyState,
  type RuntimeMode,
  type Sample,
  type SwapPlan,
  type SwapQuote,
} from '@clmm-autopilot/core';
import { Connection, PublicKey, VersionedTransaction, type AddressLookupTableAccount, type TransactionInstruction } from '@solana/web3.js';
import { buildExitTransaction, type ExitDirection } from './executionBuilder';
import {
  createSqliteLocalReceiptLedger,
  type LocalReceiptClaimParams,
  type LocalReceiptKey,
  type LocalReceiptLedger,
} from './localReceiptLedger';
import { computeExecutionRequirements } from './requirements';
import { normalizeSolanaError } from './errors';
import { loadPositionSnapshot } from './orcaInspector';
import { deriveReceiptPda, fetchReceiptByPda } from './receipt';
import { verifyReceiptProgramOnChain } from './receiptProgramVerification';
import { refreshBlockhashIfNeeded, shouldRebuild, withBoundedRetry } from './reliability';
import type { CanonicalErrorCode } from './types';
import { SOL_MINT } from './ata';
import { deriveSwapTickArrays } from './swap/tickArrays';
import { getSwapAdapter } from './swap/registry';
import type { SolanaSwapContext } from './swap/types';
import { deriveEffectiveOperatorState, enforceExecutionGate, validateRuntimeEnvironment, type RuntimeEnvironment } from './runtime';
import { createExecutionTransport, type ExecutionTransport } from './transport';
import {
  createCorrelationId,
  createRuntimeCounterRegistry,
  emitRuntimeEvent,
  type RuntimeCounterRegistry,
  type RuntimeEvent,
  type RuntimeObserver,
} from './telemetry';

const ZERO_PUBKEY = '11111111111111111111111111111111';
type SuppliedQuote = {
  inputMint: PublicKey;
  outputMint: PublicKey;
  inAmount: bigint;
  outAmount: bigint;
  quotedAtUnixMs: number;
  raw?: unknown;
};

export type ExecuteOnceCertificationHooks = {
  forceQuoteRebuildReason?: 'QUOTE_STALE' | 'BOUND_CROSSED' | 'TICK_MOVED';
  forceBlockhashRefresh?: boolean;
  forceRetryError?: {
    key: string;
    code: CanonicalErrorCode;
    message: string;
    retryable: boolean;
  };
};

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
    whirlpoolAddress: string;
    currentTick: number;
    lowerTick: number;
    upperTick: number;
    inRange: boolean;
    pairLabel: string;
    pairValid: boolean;
    tokenProgramA: string;
    tokenProgramB: string;
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
      whirlpoolAddress: snapshot.whirlpool.toBase58(),
      currentTick: snapshot.currentTickIndex,
      lowerTick: snapshot.lowerTickIndex,
      upperTick: snapshot.upperTickIndex,
      inRange: snapshot.inRange,
      pairLabel: snapshot.pairLabel,
      pairValid: snapshot.pairValid,
      tokenProgramA: snapshot.tokenProgramA.toBase58(),
      tokenProgramB: snapshot.tokenProgramB.toBase58(),
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
  receiptIdentityEnv?: Record<string, string | undefined>;
  runtimeEnvironment?: Omit<RuntimeEnvironment, 'receiptIdentityEnv'>;
  receiptEpochUnixMs?: number;
  decisionOverride?: {
    decision: Exclude<RefreshResult['decision']['decision'], 'HOLD'>;
    reasonCode?: string;
  };
  // Backward-compatible optional inputs (ignored by planner path when omitted).
  quote?: unknown;
  quoteContext?: { quotedAtSlot?: number; quoteTickIndex?: number };
  attestationHash?: Uint8Array;
  attestationPayloadBytes?: Uint8Array;
  buildJupiterSwapIxs?: unknown;
  rebuildSnapshotAndQuote?: unknown;
  signAndSend?: (tx: VersionedTransaction) => Promise<string>;
  transport?: ExecutionTransport;
  sleep?: (ms: number) => Promise<void>;
  nowUnixMs?: () => number;
  receiptLedger?: LocalReceiptLedger;
  // Deprecated test seam retained to ease migration onto receiptLedger.
  checkExistingReceipt?: (receiptPda: PublicKey) => Promise<boolean>;
  onSimulationComplete?: (summary: string) => Promise<void> | void;
  observer?: RuntimeObserver;
  counters?: RuntimeCounterRegistry;
  correlationId?: string;
  certificationHooks?: ExecuteOnceCertificationHooks;
};

export type ExecuteOnceResult = {
  status: 'HOLD' | 'SIMULATED' | 'EXECUTED' | 'ERROR';
  refresh?: RefreshResult;
  metadata?: {
    operator: {
      runtimeMode: RuntimeMode;
      executionMode: ExecutionMode;
      executionPausedDefault: boolean;
      executionPaused: boolean;
      executionPausedOverride?: boolean;
    };
    decision: {
      decision: RefreshResult['decision']['decision'];
      reasonCode: string;
    };
    swap: {
      swapPlanned: boolean;
      swapSkipped: boolean;
      swapSkipReason: 'NONE' | 'DUST' | 'ROUTER_DISABLED';
      swapRouter: AutopilotConfig['execution']['swapRouter'];
      swapInstructionCount: number;
    };
    reliability: {
      quoteRebuilt: boolean;
      quoteRebuildReason?: 'QUOTE_STALE' | 'BOUND_CROSSED' | 'TICK_MOVED';
      blockhashRefreshed: boolean;
      retryAttempts: Record<string, number>;
    };
    executionIntent: {
      removeLiquidityPlanned: boolean;
      collectFeesPlanned: boolean;
      localReceiptDbPath?: string;
      localReceiptReadPlanned: boolean;
      localReceiptClaimed: boolean;
      localReceiptConfirmed: boolean;
      localReceiptStatus: 'not_configured' | 'clear' | 'pending' | 'confirmed' | 'failed';
      onChainReceiptEnabled: boolean;
      onChainReceiptWritePlanned: boolean;
      onChainReceiptConfigValid: boolean;
      onChainReceiptStepStructurallyBuildable: boolean;
      onChainReceiptIxIncluded: boolean;
      onChainReceiptVerified: boolean;
      receiptWritePlanned: boolean;
      receiptConfigValid: boolean;
      receiptStepStructurallyBuildable: boolean;
      receiptIxIncluded: boolean;
    };
    counters: ReturnType<RuntimeCounterRegistry['snapshot']>;
  };
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
  shadow?: {
    txBuildStatus: 'BUILD_OK' | 'BUILD_FAILED';
    direction: 'trigger_up' | 'trigger_down';
    quoteSummary: {
      inAmount: string;
      minOut: string;
      slippageBps: number;
      quoteAgeMs: number;
    };
    candidateInstructionSummary: {
      removeLiquidityPlanned: boolean;
      collectFeesPlanned: boolean;
      swapInstructionCount: number;
      onChainReceiptEnabled: boolean;
      receiptIxIncluded: boolean;
    };
    tokenProgramSummary: {
      mintAProgram: string;
      mintBProgram: string;
    };
    localReceiptStatus: 'not_configured' | 'clear' | 'pending' | 'confirmed' | 'failed';
    onChainReceiptEnabled: boolean;
    onChainReceiptVerified: boolean;
    receiptPdaExpected?: string;
    receiptConfigValid: boolean;
    receiptStepStructurallyBuildable: boolean;
    receiptIxIncluded: boolean;
  };
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

function buildPlanQuoteFromSupplied(router: AutopilotConfig['execution']['swapRouter'], suppliedQuote: SuppliedQuote, slippageBpsCap: number): SwapQuote {
  if (router === 'jupiter' && suppliedQuote.raw === undefined) {
    throw {
      code: 'DATA_UNAVAILABLE',
      retryable: false,
      message: 'supplied quote missing raw Jupiter payload required for swap instruction build',
      debug: { router, suppliedQuoteKeys: Object.keys(suppliedQuote as Record<string, unknown>) },
    } satisfies { code: CanonicalErrorCode; retryable: boolean; message: string; debug: Record<string, unknown> };
  }
  if (router === 'orca' && suppliedQuote.raw === undefined) {
    throw {
      code: 'DATA_UNAVAILABLE',
      retryable: false,
      message: 'supplied quote missing raw Orca payload required for swap instruction build',
      debug: { router, suppliedQuoteKeys: Object.keys(suppliedQuote as Record<string, unknown>) },
    } satisfies { code: CanonicalErrorCode; retryable: boolean; message: string; debug: Record<string, unknown> };
  }
  const debug =
    router === 'jupiter' && suppliedQuote.raw !== undefined
      ? { jupiterRaw: suppliedQuote.raw }
      : router === 'orca' && suppliedQuote.raw !== undefined
        ? { orcaQuote: suppliedQuote.raw }
        : undefined;
  return {
    router,
    inMint: suppliedQuote.inputMint.toBase58(),
    outMint: suppliedQuote.outputMint.toBase58(),
    swapInAmount: suppliedQuote.inAmount,
    swapMinOutAmount: suppliedQuote.outAmount,
    slippageBpsCap,
    quotedAtUnixSec: Math.floor(suppliedQuote.quotedAtUnixMs / 1000),
    ...(debug ? { debug } : {}),
  };
}

function runtimeModeToDecisionStatus(operatorState: ReturnType<typeof deriveEffectiveOperatorState>): RuntimeEvent['status'] {
  if (operatorState.executionMode === 'mainnet-shadow') return 'ok';
  return operatorState.runtimeMode === 'simulate-only' ? 'hypothetical' : 'ok';
}

function isConfigValidationErrorCode(code: CanonicalErrorCode): boolean {
  return (
    code === 'CONFIG_INVALID' ||
    code === 'RPC_URL_MISSING' ||
    code === 'RUNTIME_MODE_INVALID' ||
    code === 'WALLET_PROVIDER_MISSING' ||
    code === 'RECEIPT_PROGRAM_NOT_CONFIGURED' ||
    code === 'RECEIPT_CONFIG_INCOMPLETE_FOR_SHADOW' ||
    code === 'RECEIPT_IDL_MISMATCH' ||
    code === 'RECEIPT_PROGRAM_VERIFICATION_FAILED' ||
    code === 'SWAP_ROUTER_UNSUPPORTED_CLUSTER'
  );
}

function baseEvent(
  params: ExecuteOnceParams,
  correlationId: string,
  operatorState: ReturnType<typeof deriveEffectiveOperatorState>,
  fields: Pick<RuntimeEvent, 'event' | 'status'> & Partial<Omit<RuntimeEvent, 'event' | 'status' | 'timestamp' | 'cluster' | 'runtimeMode' | 'executionPaused' | 'correlationId'>>,
): RuntimeEvent {
  return {
    event: fields.event,
    timestamp: new Date().toISOString(),
    cluster: params.config.cluster,
    executionMode: operatorState.executionMode,
    runtimeMode: operatorState.runtimeMode,
    executionPaused: operatorState.executionPaused,
    authority: params.authority.toBase58(),
    position: params.position.toBase58(),
    correlationId,
    status: fields.status,
    whirlpool: fields.whirlpool,
    router: fields.router ?? params.config.execution.swapRouter,
    direction: fields.direction,
    errorCode: fields.errorCode,
    details: fields.details,
  };
}

function buildMetadata(params: {
  config: AutopilotConfig;
  operatorState: ReturnType<typeof deriveEffectiveOperatorState>;
  counters: RuntimeCounterRegistry;
  decision?: NonNullable<ExecuteOnceResult['metadata']>['decision'];
  swap?: NonNullable<ExecuteOnceResult['metadata']>['swap'];
  reliability: NonNullable<ExecuteOnceResult['metadata']>['reliability'];
  executionIntent: NonNullable<ExecuteOnceResult['metadata']>['executionIntent'];
}): NonNullable<ExecuteOnceResult['metadata']> {
  return {
    operator: {
      executionMode: params.operatorState.executionMode,
      runtimeMode: params.operatorState.runtimeMode,
      executionPausedDefault: params.operatorState.executionPausedDefault,
      executionPaused: params.operatorState.executionPaused,
      executionPausedOverride: params.operatorState.executionPausedOverride,
    },
    decision: params.decision ?? {
      decision: 'HOLD',
      reasonCode: 'EXECUTION_FAILED_BEFORE_DECISION',
    },
    swap: params.swap ?? {
      swapPlanned: false,
      swapSkipped: true,
      swapSkipReason: 'NONE',
      swapRouter: params.config.execution.swapRouter,
      swapInstructionCount: 0,
    },
    reliability: params.reliability,
    executionIntent: params.executionIntent,
    counters: params.counters.snapshot(),
  };
}

function buildExecutionIntent(params: {
  config: AutopilotConfig;
  removeLiquidityPlanned: boolean;
  collectFeesPlanned: boolean;
  localReceiptReadPlanned: boolean;
  localReceiptClaimed: boolean;
  localReceiptConfirmed: boolean;
  localReceiptStatus: NonNullable<ExecuteOnceResult['metadata']>['executionIntent']['localReceiptStatus'];
  onChainReceiptEnabled: boolean;
  onChainReceiptWritePlanned: boolean;
  onChainReceiptConfigValid: boolean;
  onChainReceiptStepStructurallyBuildable: boolean;
  onChainReceiptIxIncluded: boolean;
  onChainReceiptVerified: boolean;
}): NonNullable<ExecuteOnceResult['metadata']>['executionIntent'] {
  return {
    removeLiquidityPlanned: params.removeLiquidityPlanned,
    collectFeesPlanned: params.collectFeesPlanned,
    localReceiptDbPath: params.config.execution.localReceiptDbPath,
    localReceiptReadPlanned: params.localReceiptReadPlanned,
    localReceiptClaimed: params.localReceiptClaimed,
    localReceiptConfirmed: params.localReceiptConfirmed,
    localReceiptStatus: params.localReceiptStatus,
    onChainReceiptEnabled: params.onChainReceiptEnabled,
    onChainReceiptWritePlanned: params.onChainReceiptWritePlanned,
    onChainReceiptConfigValid: params.onChainReceiptConfigValid,
    onChainReceiptStepStructurallyBuildable: params.onChainReceiptStepStructurallyBuildable,
    onChainReceiptIxIncluded: params.onChainReceiptIxIncluded,
    onChainReceiptVerified: params.onChainReceiptVerified,
    receiptWritePlanned: params.onChainReceiptWritePlanned,
    receiptConfigValid: params.onChainReceiptConfigValid,
    receiptStepStructurallyBuildable: params.onChainReceiptStepStructurallyBuildable,
    receiptIxIncluded: params.onChainReceiptIxIncluded,
  };
}

export async function executeOnce(params: ExecuteOnceParams): Promise<ExecuteOnceResult> {
  const sleep = params.sleep ?? (async (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const nowUnixMs = params.nowUnixMs ?? (() => Date.now());
  const ownedReceiptLedger =
    !params.receiptLedger && params.config.execution.localReceiptDbPath
      ? createSqliteLocalReceiptLedger(params.config.execution.localReceiptDbPath)
      : null;
  const receiptLedger = params.receiptLedger ?? ownedReceiptLedger;
  const effectiveRuntimeMode = deriveRuntimeModeFromExecutionMode(
    params.config.executionMode,
    params.config.operator.runtimeMode,
  );
  const counters = params.counters ?? createRuntimeCounterRegistry();
  const correlationId = params.correlationId ?? createCorrelationId();
  const runtimeEnvironment: RuntimeEnvironment = {
    rpcUrl: params.runtimeEnvironment?.rpcUrl ?? ((params.connection as unknown as { rpcEndpoint?: string }).rpcEndpoint ?? 'http://runtime.local'),
    commitment: params.runtimeEnvironment?.commitment ?? 'confirmed',
    walletConnected: params.runtimeEnvironment?.walletConnected ?? Boolean(params.signAndSend),
    signingAvailable: params.runtimeEnvironment?.signingAvailable ?? Boolean(params.signAndSend),
    executionPausedOverride: params.runtimeEnvironment?.executionPausedOverride,
    receiptIdentityEnv: params.receiptIdentityEnv,
  };
  const transport = params.transport ?? createExecutionTransport({
    executionMode: params.config.executionMode,
    signAndSend: params.signAndSend,
  });
  const retryAttempts: Record<string, number> = {};
  let quoteRebuilt = false;
  let quoteRebuildReason: 'QUOTE_STALE' | 'BOUND_CROSSED' | 'TICK_MOVED' | undefined;
  let blockhashRefreshed = false;
  let snapshotFetched = false;
  let buildStarted = false;
  let simulationStarted = false;
  let sendStarted = false;
  let txBuilt = false;
  let shadowDetails: ExecuteOnceResult['shadow'] | undefined;
  let localReceiptKey: LocalReceiptKey | undefined;
  let localReceiptClaimToken: string | undefined;
  let localReceiptReadPlanned = Boolean(receiptLedger);
  let localReceiptClaimed = false;
  let localReceiptConfirmed = false;
  let localReceiptStatus: NonNullable<ExecuteOnceResult['metadata']>['executionIntent']['localReceiptStatus'] =
    receiptLedger ? 'clear' : 'not_configured';
  let onChainReceiptVerified = false;
  let sig = '';
  let operatorState = {
    ...deriveEffectiveOperatorState(params.config, runtimeEnvironment.executionPausedOverride),
    runtimeMode: effectiveRuntimeMode,
  };

  const withRetry = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    let attempts = 0;
    try {
      return await withBoundedRetry(async () => {
        attempts += 1;
        if (params.certificationHooks?.forceRetryError?.key === key) {
          throw {
            code: params.certificationHooks.forceRetryError.code,
            retryable: params.certificationHooks.forceRetryError.retryable,
            message: params.certificationHooks.forceRetryError.message,
          } satisfies { code: CanonicalErrorCode; retryable: boolean; message: string };
        }
        return fn();
      }, sleep, params.config.execution);
    } finally {
      retryAttempts[key] = attempts;
    }
  };

  try {
    validateRuntimeEnvironment(runtimeEnvironment);
    const gate = enforceExecutionGate({
      config: params.config,
      runtimeEnvironment,
      requireSigning: params.config.executionMode !== 'mainnet-shadow',
    });
    operatorState = gate.operatorState;
    const receiptIdentity = gate.receiptIdentity;
    const onChainReceiptEnabled = params.config.execution.onChainReceiptEnabled;
    const receiptConfigValid = onChainReceiptEnabled ? Boolean(receiptIdentity) : false;
    const receiptStepStructurallyBuildable = onChainReceiptEnabled ? Boolean(receiptIdentity) : false;
    const receiptIxIncluded = operatorState.executionMode !== 'mainnet-shadow' && Boolean(receiptIdentity);
    if (receiptIdentity) {
      await verifyReceiptProgramOnChain(params.connection, receiptIdentity);
    }
    const refreshed = await withRetry('refreshPositionDecision', () => refreshPositionDecision(params));
    snapshotFetched = true;
    const effectiveRefresh = params.decisionOverride
      ? {
          ...refreshed,
          decision: {
            ...refreshed.decision,
            decision: params.decisionOverride.decision,
            reasonCode: params.decisionOverride.reasonCode ?? refreshed.decision.reasonCode,
          },
        }
      : refreshed;
    emitRuntimeEvent(
      params.observer,
      counters,
      baseEvent(params, correlationId, operatorState, {
        event: 'monitor.snapshot_fetched',
        status: 'ok',
        details: { decision: effectiveRefresh.decision.decision, reasonCode: effectiveRefresh.decision.reasonCode },
      }),
    );

    const router = params.config.execution.swapRouter;

    if (effectiveRefresh.decision.decision === 'HOLD') {
      if (effectiveRefresh.decision.cooldownRemainingMs > 0) {
        emitRuntimeEvent(
          params.observer,
          counters,
          baseEvent(params, correlationId, operatorState, {
            event: 'policy.cooldown_active',
            status: 'ok',
            details: { cooldownRemainingMs: effectiveRefresh.decision.cooldownRemainingMs },
          }),
        );
      }
      emitRuntimeEvent(
        params.observer,
        counters,
        baseEvent(params, correlationId, operatorState, {
          event: 'policy.decision_hold',
          status: runtimeModeToDecisionStatus(operatorState),
          details: { reasonCode: effectiveRefresh.decision.reasonCode },
        }),
      );
      return {
        status: 'HOLD',
        refresh: effectiveRefresh,
        metadata: buildMetadata({
          config: params.config,
          operatorState,
          counters,
          decision: {
            decision: effectiveRefresh.decision.decision,
            reasonCode: effectiveRefresh.decision.reasonCode,
          },
          swap: {
            swapPlanned: false,
            swapSkipped: true,
            swapSkipReason: 'NONE',
            swapRouter: router,
            swapInstructionCount: 0,
          },
          reliability: {
            quoteRebuilt: false,
            blockhashRefreshed: false,
            retryAttempts,
          },
            executionIntent: buildExecutionIntent({
              config: params.config,
              removeLiquidityPlanned: false,
              collectFeesPlanned: false,
              localReceiptReadPlanned,
              localReceiptClaimed,
              localReceiptConfirmed,
              localReceiptStatus,
              onChainReceiptEnabled,
              onChainReceiptWritePlanned: false,
              onChainReceiptConfigValid: receiptConfigValid,
              onChainReceiptStepStructurallyBuildable: receiptStepStructurallyBuildable,
              onChainReceiptIxIncluded: false,
              onChainReceiptVerified,
            }),
          }),
      };
    }

    emitRuntimeEvent(
      params.observer,
      counters,
      baseEvent(params, correlationId, operatorState, {
        event:
          effectiveRefresh.decision.decision === 'TRIGGER_UP'
            ? 'policy.decision_trigger_up'
            : 'policy.decision_trigger_down',
        status: runtimeModeToDecisionStatus(operatorState),
        details: { reasonCode: effectiveRefresh.decision.reasonCode },
      }),
    );

    const adapter = router === 'noop' ? null : getSwapAdapter(router, params.config.cluster);

    let snapshot = await withRetry('loadPositionSnapshot.initial', () =>
      loadPositionSnapshot(params.connection, params.position, params.config.cluster),
    );

    const direction = effectiveRefresh.decision.decision === 'TRIGGER_UP' ? ('UP' as ExitDirection) : ('DOWN' as ExitDirection);

    const latestSlot = await withRetry('connection.getSlot', () => params.connection.getSlot('confirmed'));
    const epochSourceMs = params.receiptEpochUnixMs ?? nowUnixMs();
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
      const suppliedQuote = params.quote as SuppliedQuote | undefined;
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
        if (!adapter) {
          throw {
            code: 'DATA_UNAVAILABLE',
            retryable: false,
            message: 'swap adapter unavailable for configured router',
            debug: { router, cluster: params.config.cluster },
          } satisfies { code: CanonicalErrorCode; retryable: boolean; message: string; debug: Record<string, unknown> };
        }
        if (suppliedQuote) {
          planQuote = buildPlanQuoteFromSupplied(router, suppliedQuote, params.config.execution.slippageBpsCap);
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
        if (swapBuild.instructions.length === 0) {
          throw {
            code: 'DATA_UNAVAILABLE',
            retryable: false,
            message: 'swap adapter returned zero instructions for a planned swap',
            debug: {
              router,
              cluster: params.config.cluster,
              inMint: planQuote.inMint,
              outMint: planQuote.outMint,
              swapInAmount: planQuote.swapInAmount.toString(),
              swapMinOutAmount: planQuote.swapMinOutAmount.toString(),
            },
          } satisfies { code: CanonicalErrorCode; retryable: boolean; message: string; debug: Record<string, unknown> };
        }
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

    let assembled = await withRetry('buildPlan.initial', () => buildPlan(snapshot));

    const rebuildCheck = params.certificationHooks?.forceQuoteRebuildReason
      ? { rebuild: true, reasonCode: params.certificationHooks.forceQuoteRebuildReason }
      : shouldRebuild(
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
      quoteRebuilt = true;
      quoteRebuildReason = rebuildCheck.reasonCode;
      snapshot = await withRetry('loadPositionSnapshot.rebuild', () =>
        loadPositionSnapshot(params.connection, params.position, params.config.cluster),
      );
      assembled = await withRetry('buildPlan.rebuild', () => buildPlan(snapshot));
      emitRuntimeEvent(
        params.observer,
        counters,
        baseEvent(params, correlationId, operatorState, {
          event: 'execution.build_started',
          status: 'started',
          direction,
          whirlpool: snapshot.whirlpool.toBase58(),
          details: { reasonCode: rebuildCheck.reasonCode ?? 'QUOTE_STALE', rebuild: true },
        }),
      );
    }

    const receiptPda = receiptIdentity
      ? deriveReceiptPda({
          authority: params.authority,
          positionMint: snapshot.positionMint,
          epoch,
          programId: receiptIdentity.programId,
        })[0]
      : null;
    const quoteAgeMs = assembled.plan.quote.quotedAtUnixSec > 0
      ? Math.max(0, nowUnixMs() - (assembled.plan.quote.quotedAtUnixSec * 1000))
      : 0;
    shadowDetails = {
      txBuildStatus: 'BUILD_FAILED',
      direction: direction === 'UP' ? 'trigger_up' : 'trigger_down',
      quoteSummary: {
        inAmount: assembled.plan.quote.swapInAmount.toString(),
        minOut: assembled.plan.quote.swapMinOutAmount.toString(),
        slippageBps: params.config.execution.slippageBpsCap,
        quoteAgeMs,
      },
      candidateInstructionSummary: {
        removeLiquidityPlanned: true,
        collectFeesPlanned: true,
        swapInstructionCount: assembled.swapIxs.length,
        onChainReceiptEnabled,
        receiptIxIncluded,
      },
      tokenProgramSummary: {
        mintAProgram: snapshot.tokenProgramA.toBase58(),
        mintBProgram: snapshot.tokenProgramB.toBase58(),
      },
      localReceiptStatus,
      onChainReceiptEnabled,
      onChainReceiptVerified,
      receiptPdaExpected: receiptPda?.toBase58(),
      receiptConfigValid,
      receiptStepStructurallyBuildable,
      receiptIxIncluded,
    };
    localReceiptKey = {
      cluster: params.config.cluster,
      authority: params.authority.toBase58(),
      positionMint: snapshot.positionMint.toBase58(),
      epoch,
    };
    if (receiptLedger && localReceiptKey) {
      if (params.checkExistingReceipt && receiptPda) {
        const existingReceipt = await params.checkExistingReceipt(receiptPda);
        if (existingReceipt) {
          localReceiptStatus = 'confirmed';
          if (shadowDetails) shadowDetails.localReceiptStatus = localReceiptStatus;
          emitRuntimeEvent(
            params.observer,
            counters,
            baseEvent(params, correlationId, operatorState, {
              event: 'execution.receipt_precheck_exists',
              status: 'failed',
              direction,
              whirlpool: snapshot.whirlpool.toBase58(),
              errorCode: 'ALREADY_EXECUTED_THIS_EPOCH',
              details: {
                epoch,
                localReceiptStatus,
                source: 'legacy-checkExistingReceipt',
                onChainReceiptPda: receiptPda.toBase58(),
              },
            }),
          );
          return {
            status: 'ERROR',
            refresh: effectiveRefresh,
            errorCode: 'ALREADY_EXECUTED_THIS_EPOCH',
            errorMessage: 'Execution receipt already exists for canonical epoch',
            shadow: shadowDetails,
            metadata: buildMetadata({
              config: params.config,
              operatorState,
              counters,
              decision: {
                decision: effectiveRefresh.decision.decision,
                reasonCode: effectiveRefresh.decision.reasonCode,
              },
              swap: {
                swapPlanned: assembled.plan.swapPlanned,
                swapSkipped: !assembled.plan.swapPlanned,
                swapSkipReason: assembled.plan.swapSkipReason,
                swapRouter: assembled.plan.swapRouter,
                swapInstructionCount: assembled.swapIxs.length,
              },
              reliability: {
                quoteRebuilt,
                ...(quoteRebuildReason ? { quoteRebuildReason } : {}),
                blockhashRefreshed,
                retryAttempts,
              },
              executionIntent: buildExecutionIntent({
                config: params.config,
                removeLiquidityPlanned: true,
                collectFeesPlanned: true,
                localReceiptReadPlanned,
                localReceiptClaimed,
                localReceiptConfirmed,
                localReceiptStatus,
                onChainReceiptEnabled,
                onChainReceiptWritePlanned: Boolean(receiptPda),
                onChainReceiptConfigValid: receiptConfigValid,
                onChainReceiptStepStructurallyBuildable: receiptStepStructurallyBuildable,
                onChainReceiptIxIncluded: receiptIxIncluded,
                onChainReceiptVerified,
              }),
            }),
          };
        }
      }
      const precheck = receiptLedger.inspect(
        localReceiptKey,
        nowUnixMs(),
        params.config.execution.localReceiptClaimTtlMs,
      );
      if (precheck.kind === 'blocked') {
        localReceiptStatus = precheck.status;
        if (shadowDetails) shadowDetails.localReceiptStatus = localReceiptStatus;
        emitRuntimeEvent(
          params.observer,
          counters,
          baseEvent(params, correlationId, operatorState, {
            event: 'execution.receipt_precheck_exists',
            status: 'failed',
            direction,
            whirlpool: snapshot.whirlpool.toBase58(),
            errorCode: 'ALREADY_EXECUTED_THIS_EPOCH',
            details: {
              epoch,
              localReceiptStatus: precheck.status,
              localReceiptDbPath: receiptLedger.dbPath,
              onChainReceiptPda: receiptPda?.toBase58(),
            },
          }),
        );
        return {
          status: 'ERROR',
          refresh: effectiveRefresh,
          errorCode: 'ALREADY_EXECUTED_THIS_EPOCH',
          errorMessage:
            precheck.status === 'confirmed'
              ? 'Local receipt ledger already contains a confirmed execution for this epoch'
              : 'Local receipt ledger contains a fresh pending execution claim for this epoch',
          shadow: shadowDetails,
          metadata: buildMetadata({
            config: params.config,
            operatorState,
            counters,
            decision: {
              decision: effectiveRefresh.decision.decision,
              reasonCode: effectiveRefresh.decision.reasonCode,
            },
            swap: {
              swapPlanned: assembled.plan.swapPlanned,
              swapSkipped: !assembled.plan.swapPlanned,
              swapSkipReason: assembled.plan.swapSkipReason,
              swapRouter: assembled.plan.swapRouter,
              swapInstructionCount: assembled.swapIxs.length,
            },
            reliability: {
              quoteRebuilt,
              ...(quoteRebuildReason ? { quoteRebuildReason } : {}),
              blockhashRefreshed,
              retryAttempts,
            },
            executionIntent: buildExecutionIntent({
              config: params.config,
              removeLiquidityPlanned: true,
              collectFeesPlanned: true,
              localReceiptReadPlanned,
              localReceiptClaimed,
              localReceiptConfirmed,
              localReceiptStatus,
              onChainReceiptEnabled,
              onChainReceiptWritePlanned: Boolean(receiptPda),
              onChainReceiptConfigValid: receiptConfigValid,
              onChainReceiptStepStructurallyBuildable: receiptStepStructurallyBuildable,
              onChainReceiptIxIncluded: receiptIxIncluded,
              onChainReceiptVerified,
            }),
          }),
        };
      }
      localReceiptStatus = 'clear';
      if (shadowDetails) shadowDetails.localReceiptStatus = localReceiptStatus;
      emitRuntimeEvent(
        params.observer,
        counters,
        baseEvent(params, correlationId, operatorState, {
          event: 'execution.receipt_precheck_zero',
          status: 'ok',
          direction,
          whirlpool: snapshot.whirlpool.toBase58(),
          details: {
            epoch,
            localReceiptDbPath: receiptLedger.dbPath,
            onChainReceiptPda: receiptPda?.toBase58(),
          },
        }),
      );
    }

    if (assembled.plan.swapSkipReason === 'DUST') {
      emitRuntimeEvent(
        params.observer,
        counters,
        baseEvent(params, correlationId, operatorState, {
          event: 'execution.swap_skipped_dust',
          status: 'ok',
          direction,
          whirlpool: snapshot.whirlpool.toBase58(),
          details: { swapRouter: assembled.plan.swapRouter },
        }),
      );
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

    const availableLamports = await withRetry('connection.getBalance', () => params.connection.getBalance(params.authority));

    const fetchedAtUnixMs = params.certificationHooks?.forceBlockhashRefresh
      ? nowUnixMs() - ((params.config.execution.quoteFreshnessSec * 1000) + 1)
      : nowUnixMs();
    let latestBlockhash = await withRetry('connection.getLatestBlockhash.initial', () => params.connection.getLatestBlockhash());

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
        receiptProgramId: receiptIxIncluded ? receiptIdentity?.programId : undefined,
        receiptIdlPath: receiptIxIncluded ? receiptIdentity?.idlPath : undefined,
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

    buildStarted = true;
    emitRuntimeEvent(
      params.observer,
      counters,
      baseEvent(params, correlationId, operatorState, {
        event: 'execution.build_started',
        status: 'started',
        direction,
        whirlpool: snapshot.whirlpool.toBase58(),
      }),
    );
    simulationStarted = true;
    emitRuntimeEvent(
      params.observer,
      counters,
      baseEvent(params, correlationId, operatorState, {
        event: 'execution.simulation_started',
        status: 'started',
        direction,
        whirlpool: snapshot.whirlpool.toBase58(),
      }),
    );
    let msg = (await buildTx(latestBlockhash.blockhash)) as VersionedTransaction;
    txBuilt = true;
    if (shadowDetails) shadowDetails.txBuildStatus = 'BUILD_OK';
    const simSummary = 'Simulation passed';
    await params.onSimulationComplete?.(simSummary);

    if (operatorState.runtimeMode === 'simulate-only') {
      return {
        status: 'SIMULATED',
        refresh: effectiveRefresh,
        shadow: shadowDetails,
        metadata: buildMetadata({
          config: params.config,
          operatorState,
          counters,
          decision: {
            decision: effectiveRefresh.decision.decision,
            reasonCode: effectiveRefresh.decision.reasonCode,
          },
          swap: {
            swapPlanned: assembled.plan.swapPlanned,
            swapSkipped: !assembled.plan.swapPlanned,
            swapSkipReason: assembled.plan.swapSkipReason,
            swapRouter: assembled.plan.swapRouter,
            swapInstructionCount: assembled.swapIxs.length,
          },
          reliability: {
            quoteRebuilt,
            ...(quoteRebuildReason ? { quoteRebuildReason } : {}),
            blockhashRefreshed,
            retryAttempts,
          },
          executionIntent: buildExecutionIntent({
            config: params.config,
            removeLiquidityPlanned: true,
            collectFeesPlanned: true,
            localReceiptReadPlanned,
            localReceiptClaimed,
            localReceiptConfirmed,
            localReceiptStatus,
            onChainReceiptEnabled,
            onChainReceiptWritePlanned: false,
            onChainReceiptConfigValid: receiptConfigValid,
            onChainReceiptStepStructurallyBuildable: receiptStepStructurallyBuildable,
            onChainReceiptIxIncluded: receiptIxIncluded,
            onChainReceiptVerified,
          }),
        }),
        execution: {
          unsignedTxBuilt: true,
          simulated: true,
          simLogs: [simSummary],
        },
        simSummary,
      };
    }

    if (receiptLedger && localReceiptKey) {
      localReceiptClaimToken = `${correlationId}:${nowUnixMs()}`;
      const claim = receiptLedger.claim({
        ...(localReceiptKey satisfies LocalReceiptKey),
        executionMode: params.config.executionMode,
        positionAddress: snapshot.position.toBase58(),
        whirlpoolAddress: snapshot.whirlpool.toBase58(),
        direction,
        attestationHash,
        attestationPayloadBytes,
        claimToken: localReceiptClaimToken,
        nowUnixMs: nowUnixMs(),
        claimTtlMs: params.config.execution.localReceiptClaimTtlMs,
        onChainReceiptEnabled,
        onChainReceiptPda: receiptPda?.toBase58(),
      } satisfies LocalReceiptClaimParams);
      if (claim.kind === 'blocked') {
        localReceiptStatus = claim.status;
        if (shadowDetails) shadowDetails.localReceiptStatus = localReceiptStatus;
        return {
          status: 'ERROR',
          refresh: effectiveRefresh,
          errorCode: 'ALREADY_EXECUTED_THIS_EPOCH',
          errorMessage:
            claim.status === 'confirmed'
              ? 'Local receipt ledger already contains a confirmed execution for this epoch'
              : 'Local receipt ledger contains a fresh pending execution claim for this epoch',
          shadow: shadowDetails,
          metadata: buildMetadata({
            config: params.config,
            operatorState,
            counters,
            decision: {
              decision: effectiveRefresh.decision.decision,
              reasonCode: effectiveRefresh.decision.reasonCode,
            },
            swap: {
              swapPlanned: assembled.plan.swapPlanned,
              swapSkipped: !assembled.plan.swapPlanned,
              swapSkipReason: assembled.plan.swapSkipReason,
              swapRouter: assembled.plan.swapRouter,
              swapInstructionCount: assembled.swapIxs.length,
            },
            reliability: {
              quoteRebuilt,
              ...(quoteRebuildReason ? { quoteRebuildReason } : {}),
              blockhashRefreshed,
              retryAttempts,
            },
            executionIntent: buildExecutionIntent({
              config: params.config,
              removeLiquidityPlanned: true,
              collectFeesPlanned: true,
              localReceiptReadPlanned,
              localReceiptClaimed,
              localReceiptConfirmed,
              localReceiptStatus,
              onChainReceiptEnabled,
              onChainReceiptWritePlanned: Boolean(receiptPda),
              onChainReceiptConfigValid: receiptConfigValid,
              onChainReceiptStepStructurallyBuildable: receiptStepStructurallyBuildable,
              onChainReceiptIxIncluded: receiptIxIncluded,
              onChainReceiptVerified,
            }),
          }),
        };
      }
      localReceiptClaimed = true;
      localReceiptStatus = 'pending';
      if (shadowDetails) shadowDetails.localReceiptStatus = localReceiptStatus;
    }

    const submitTx = async (): Promise<string> => {
      counters.increment('submitInvocations');
      if (transport.kind === 'live') {
        counters.increment('signerInvocations');
        counters.increment('walletPromptCount');
      }
      const signature = await transport.submit(msg);
      if (operatorState.executionMode === 'mainnet-shadow' && signature) {
        counters.increment('shadowTxSignaturesEmitted');
      }
      return signature;
    };
    try {
      if (operatorState.executionMode === 'mainnet-shadow') {
        throw {
          code: 'EXECUTION_MODE_SEND_FORBIDDEN',
          retryable: false,
          message: 'Shadow mode cannot submit transactions',
          debug: { executionMode: operatorState.executionMode },
        } satisfies { code: CanonicalErrorCode; retryable: boolean; message: string; debug: Record<string, unknown> };
      }
      sendStarted = true;
      emitRuntimeEvent(
        params.observer,
        counters,
        baseEvent(params, correlationId, operatorState, {
          event: 'execution.send_started',
          status: 'started',
          direction,
          whirlpool: snapshot.whirlpool.toBase58(),
        }),
      );
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
      blockhashRefreshed = blockhashRefreshed || refreshedBlockhash.rebuilt;
      sig = await submitTx();
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
      blockhashRefreshed = blockhashRefreshed || refreshedBlockhash.rebuilt;
      sig = await submitTx();
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
    if (receiptPda) {
      for (let i = 0; i < params.config.execution.receiptPollMaxAttempts; i += 1) {
        receipt = await fetchReceiptByPda(params.connection, receiptPda);
        if (receipt) break;
        await sleep(params.config.execution.receiptPollIntervalMs);
      }
    }
    onChainReceiptVerified = Boolean(receipt);

    emitRuntimeEvent(
      params.observer,
      counters,
      baseEvent(params, correlationId, operatorState, {
        event: 'execution.send_confirmed',
        status: 'ok',
        direction,
        whirlpool: snapshot.whirlpool.toBase58(),
        details: { signature: sig },
      }),
    );
    if (receipt) {
      emitRuntimeEvent(
        params.observer,
        counters,
        baseEvent(params, correlationId, operatorState, {
          event: 'execution.receipt_verified',
          status: 'ok',
          direction,
          whirlpool: snapshot.whirlpool.toBase58(),
          details: { receiptPda: receiptPda?.toBase58() },
        }),
      );
    }
    if (receiptLedger && localReceiptKey && localReceiptClaimToken) {
      receiptLedger.confirm({
        ...localReceiptKey,
        claimToken: localReceiptClaimToken,
        nowUnixMs: nowUnixMs(),
        txSignature: sig,
        confirmedSlot: receipt ? Number(receipt.slot) : undefined,
        onChainReceiptPda: receiptPda?.toBase58(),
        onChainReceiptVerified,
      });
      localReceiptConfirmed = true;
      localReceiptStatus = 'confirmed';
      if (shadowDetails) {
        shadowDetails.localReceiptStatus = localReceiptStatus;
        shadowDetails.onChainReceiptVerified = onChainReceiptVerified;
      }
    }

    return {
      status: 'EXECUTED',
      refresh: effectiveRefresh,
      shadow: shadowDetails,
      metadata: buildMetadata({
        config: params.config,
        operatorState,
        counters,
        decision: {
          decision: effectiveRefresh.decision.decision,
          reasonCode: effectiveRefresh.decision.reasonCode,
        },
        swap: {
          swapPlanned: assembled.plan.swapPlanned,
          swapSkipped: !assembled.plan.swapPlanned,
          swapSkipReason: assembled.plan.swapSkipReason,
          swapRouter: assembled.plan.swapRouter,
          swapInstructionCount: assembled.swapIxs.length,
        },
        reliability: {
          quoteRebuilt,
          ...(quoteRebuildReason ? { quoteRebuildReason } : {}),
          blockhashRefreshed,
          retryAttempts,
        },
        executionIntent: buildExecutionIntent({
          config: params.config,
          removeLiquidityPlanned: true,
          collectFeesPlanned: true,
          localReceiptReadPlanned,
          localReceiptClaimed,
          localReceiptConfirmed,
          localReceiptStatus,
          onChainReceiptEnabled,
          onChainReceiptWritePlanned: Boolean(receiptPda),
          onChainReceiptConfigValid: receiptConfigValid,
          onChainReceiptStepStructurallyBuildable: receiptStepStructurallyBuildable,
          onChainReceiptIxIncluded: receiptIxIncluded,
          onChainReceiptVerified,
        }),
      }),
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
    const txBuiltFromError =
      normalized.debug !== null &&
      typeof normalized.debug === 'object' &&
      'txBuilt' in (normalized.debug as Record<string, unknown>) &&
      (normalized.debug as Record<string, unknown>).txBuilt === true;
    if (shadowDetails) {
      shadowDetails.txBuildStatus = txBuilt || txBuiltFromError ? 'BUILD_OK' : 'BUILD_FAILED';
    }
    if (receiptLedger && localReceiptKey && localReceiptClaimToken && localReceiptClaimed && !localReceiptConfirmed) {
      try {
        receiptLedger.fail({
          ...localReceiptKey,
          claimToken: localReceiptClaimToken,
          nowUnixMs: nowUnixMs(),
          errorCode: normalized.code,
          errorMessage: normalized.message,
          errorDebug: normalized.debug,
          ...(sig ? { txSignature: sig } : {}),
          onChainReceiptPda: shadowDetails?.receiptPdaExpected,
        });
        localReceiptStatus = 'failed';
        if (shadowDetails) shadowDetails.localReceiptStatus = localReceiptStatus;
      } catch {
        // Prefer the original execution error if the ledger row was already taken over.
      }
    }
    const event =
      normalized.code === 'EXECUTION_PAUSED'
        ? 'execution.paused_block'
        : normalized.code === 'EXECUTION_MODE_BLOCKED' || normalized.code === 'EXECUTION_MODE_SEND_FORBIDDEN'
          ? 'execution.mode_blocked'
          : isConfigValidationErrorCode(normalized.code)
            ? 'config.validation_failed'
          : !snapshotFetched
            ? 'monitor.snapshot_failed'
            : sendStarted
              ? 'execution.send_failed'
              : simulationStarted && normalized.code === 'SIMULATION_FAILED'
                ? 'execution.simulation_failed'
              : buildStarted
                ? 'execution.build_failed'
                : 'monitor.snapshot_failed';
    emitRuntimeEvent(
      params.observer,
      counters,
      baseEvent(params, correlationId, operatorState, {
        event,
        status:
          normalized.code === 'EXECUTION_PAUSED' ||
          normalized.code === 'EXECUTION_MODE_BLOCKED' ||
          normalized.code === 'EXECUTION_MODE_SEND_FORBIDDEN'
            ? 'blocked'
            : 'failed',
        errorCode: normalized.code,
        details: { message: normalized.message, debug: normalized.debug },
      }),
    );
    return {
      status: 'ERROR',
      errorCode: normalized.code,
      errorMessage: normalized.message,
      errorDebug: normalized.debug,
      ...(shadowDetails ? { shadow: shadowDetails } : {}),
      metadata: buildMetadata({
        config: params.config,
        operatorState,
        counters,
        reliability: {
          quoteRebuilt,
          ...(quoteRebuildReason ? { quoteRebuildReason } : {}),
          blockhashRefreshed,
          retryAttempts,
        },
        executionIntent: buildExecutionIntent({
          config: params.config,
          removeLiquidityPlanned: shadowDetails?.candidateInstructionSummary.removeLiquidityPlanned ?? false,
          collectFeesPlanned: shadowDetails?.candidateInstructionSummary.collectFeesPlanned ?? false,
          localReceiptReadPlanned,
          localReceiptClaimed,
          localReceiptConfirmed,
          localReceiptStatus,
          onChainReceiptEnabled: params.config.execution.onChainReceiptEnabled,
          onChainReceiptWritePlanned: false,
          onChainReceiptConfigValid: shadowDetails?.receiptConfigValid ?? false,
          onChainReceiptStepStructurallyBuildable: shadowDetails?.receiptStepStructurallyBuildable ?? false,
          onChainReceiptIxIncluded: shadowDetails?.receiptIxIncluded ?? false,
          onChainReceiptVerified,
        }),
      }),
    };
  } finally {
    ownedReceiptLedger?.close();
  }
}
