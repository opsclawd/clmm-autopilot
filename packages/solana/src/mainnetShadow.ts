import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createRuntimeCounterRegistry,
  executeOnce,
  loadPositionSnapshot,
  type PositionSnapshot,
  ShadowSubmitter,
  classifyShadowSimulationResult,
} from './index';
import {
  validateConfig,
  type AutopilotConfig,
  type PolicyState,
  type Sample,
} from '@clmm-autopilot/core';
import { Connection, PublicKey } from '@solana/web3.js';
import { normalizeSolanaError } from './errors';
import {
  ShadowArtifactStore,
  type PositionSourceMode,
  type ShadowTriggerRecord,
} from './shadow/artifactStore';
import type { CanonicalErrorCode, ShadowSimulationClass } from './types';
import { PDAUtil, ParsablePosition } from '@orca-so/whirlpools-sdk';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount } from '@solana/spl-token';
import { getReceiptManifestForCluster, resolveReceiptRuntimeIdentity } from './receiptIdentity';
import { verifyReceiptProgramOnChain } from './receiptProgramVerification';

const ORCA_WHIRLPOOL_PROGRAM_ID = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');

type PositionRuntimeState = {
  samples: Sample[];
  policyState: PolicyState;
  lastEvaluationSignature?: string;
  firstOutOfRangeAtUnixMs?: number;
  coldStartPending: boolean;
  evaluationCount: number;
};

type ShadowMetrics = {
  monitoredEvaluations: number;
  triggersFired: number;
  triggersSuppressedByDebounce: number;
  candidateTxBuildAttempts: number;
  successfulSimulations: number;
  failedSimulationsByClass: Record<ShadowSimulationClass, number>;
  quoteAgeTotalMs: number;
  quoteAgeCount: number;
  triggerDelayTotalMs: number;
  triggerDelayCount: number;
  triggerUpCount: number;
  triggerDownCount: number;
};

type TypedShadowError = Error & { code: CanonicalErrorCode; retryable: boolean; debug?: unknown };

function fail(code: CanonicalErrorCode, message: string, debug?: unknown): never {
  const err = new Error(message) as TypedShadowError;
  err.code = code;
  err.retryable = false;
  if (debug !== undefined) err.debug = debug;
  throw err;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseBoolean(raw: string | undefined, fallback = false): boolean {
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no') return false;
  return fallback;
}

function parseInteger(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value));
}

function parsePositionList(raw: string | undefined): PublicKey[] {
  if (!raw) return [];
  const unique = new Set<string>();
  const out: PublicKey[] = [];
  for (const candidate of raw.split(/[\s,]+/)) {
    if (!candidate) continue;
    if (unique.has(candidate)) continue;
    unique.add(candidate);
    out.push(new PublicKey(candidate));
  }
  return out;
}

function toEvaluationSignature(decision: {
  decision: string;
  reasonCode: string;
  samplesUsed: number;
  threshold: number;
  cooldownRemainingMs: number;
}): string {
  return `${decision.decision}|${decision.reasonCode}|${decision.samplesUsed}|${decision.threshold}|${decision.cooldownRemainingMs}`;
}

function isDebounceSuppression(reasonCode: string): boolean {
  const lower = reasonCode.toLowerCase();
  return lower.includes('debounce') || lower.includes('consecutive') || lower.includes('threshold');
}

function createSessionId(authority: PublicKey, positions: readonly PublicKey[]): string {
  const digest = createHash('sha256')
    .update(`${authority.toBase58()}|${positions.map((p) => p.toBase58()).join(',')}|${Date.now()}`)
    .digest('hex')
    .slice(0, 12);
  return `shadow-${new Date().toISOString().replace(/[:.]/g, '-')}-${digest}`;
}

function mergeManifestReceiptIdentity(
  input: unknown,
  env: Record<string, string | undefined>,
): unknown {
  if (!isRecord(input)) return input;
  const hasExplicitIdentityField =
    input.receiptProgramId !== undefined ||
    input.receiptIdlHashMode !== undefined ||
    input.receiptIdlHash !== undefined ||
    input.receiptIdlPath !== undefined ||
    input.expectedUpgradeAuthority !== undefined;
  if (hasExplicitIdentityField) return input;

  const manifest = getReceiptManifestForCluster('mainnet', env);
  if (!manifest) return input;
  return {
    ...input,
    receiptProgramId: manifest.programId,
    receiptIdlHashMode: manifest.idlHashMode,
    receiptIdlHash: manifest.idlHash,
    receiptIdlPath: manifest.idlPath,
    ...(manifest.expectedUpgradeAuthority ? { expectedUpgradeAuthority: manifest.expectedUpgradeAuthority } : {}),
  };
}

function shouldMergeManifestReceiptIdentity(input: unknown): boolean {
  if (!isRecord(input)) return false;
  const execution = input.execution;
  if (!execution || !isRecord(execution)) return false;
  return execution.onChainReceiptEnabled === true;
}

export function isFatalShadowStartupCode(code: CanonicalErrorCode | undefined): boolean {
  return (
    code === 'RECEIPT_CONFIG_INCOMPLETE_FOR_SHADOW' ||
    code === 'RECEIPT_PROGRAM_NOT_CONFIGURED' ||
    code === 'RECEIPT_IDL_MISMATCH' ||
    code === 'RECEIPT_PROGRAM_VERIFICATION_FAILED'
  );
}

export function loadShadowConfig(env: Record<string, string | undefined>): AutopilotConfig {
  const raw = env.SHADOW_AUTOPILOT_CONFIG ?? env.AUTOPILOT_CONFIG;
  const fallbackCluster = env.SOLANA_CLUSTER ?? 'mainnet';
  const fallbackInput = {
    cluster: fallbackCluster,
    executionMode: 'mainnet-shadow',
    execution: {
      swapRouter: env.SWAP_ROUTER ?? 'jupiter',
      sendEnabled: false,
    },
    operator: {
      runtimeMode: 'simulate-only',
      executionPausedDefault: false,
    },
  };

  const parsedRaw = raw ? JSON.parse(raw) : {};
  const parsedInput = isRecord(parsedRaw)
    ? {
        ...fallbackInput,
        ...parsedRaw,
        execution: {
          ...fallbackInput.execution,
          ...(isRecord(parsedRaw.execution) ? parsedRaw.execution : {}),
        },
        operator: {
          ...fallbackInput.operator,
          ...(isRecord(parsedRaw.operator) ? parsedRaw.operator : {}),
        },
      }
    : fallbackInput;
  const parsed = shouldMergeManifestReceiptIdentity(parsedInput)
    ? mergeManifestReceiptIdentity(parsedInput, env)
    : parsedInput;
  const validated = validateConfig(parsed);
  if (!validated.ok) {
    const summary = validated.errors.map((e) => `${e.path}:${e.code}`).join(', ');
    throw new Error(`CONFIG_INVALID: ${summary}`);
  }
  const config = validated.value;
  if (config.cluster !== 'mainnet') {
    throw new Error(`CONFIG_INVALID: mainnet-shadow requires cluster=mainnet (received ${config.cluster})`);
  }
  if (config.executionMode !== 'mainnet-shadow') {
    throw new Error(
      `CONFIG_INVALID: expected executionMode=mainnet-shadow (received ${config.executionMode})`,
    );
  }
  if (config.execution.sendEnabled) {
    throw new Error('CONFIG_INVALID: mainnet-shadow requires execution.sendEnabled=false');
  }
  return config;
}

async function discoverPositions(connection: Connection, wallet: PublicKey): Promise<PublicKey[]> {
  const tokenAccounts = await Promise.all([
    connection.getTokenAccountsByOwner(wallet, { programId: TOKEN_PROGRAM_ID }, 'confirmed'),
    connection.getTokenAccountsByOwner(wallet, { programId: TOKEN_2022_PROGRAM_ID }, 'confirmed'),
  ]);

  const candidateMints: PublicKey[] = [];
  const seen = new Set<string>();
  for (const collection of tokenAccounts) {
    for (const { pubkey, account } of collection.value) {
      try {
        const parsed = unpackAccount(pubkey, account, account.owner);
        if (parsed.amount !== BigInt(1)) continue;
        const mintKey = parsed.mint.toBase58();
        if (seen.has(mintKey)) continue;
        seen.add(mintKey);
        candidateMints.push(parsed.mint);
      } catch {
        // Ignore malformed token accounts.
      }
    }
  }

  const positionPdas = candidateMints.map((mint) => PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, mint).publicKey);
  const out: PublicKey[] = [];
  for (let i = 0; i < positionPdas.length; i += 100) {
    const batch = positionPdas.slice(i, i + 100);
    const infos = await connection.getMultipleAccountsInfo(batch, 'confirmed');
    infos.forEach((info, idx) => {
      if (!info || !info.owner.equals(ORCA_WHIRLPOOL_PROGRAM_ID)) return;
      const decoded = ParsablePosition.parse(batch[idx], info);
      if (!decoded) return;
      out.push(batch[idx]);
    });
  }

  return out;
}

function initializeMetrics(): ShadowMetrics {
  return {
    monitoredEvaluations: 0,
    triggersFired: 0,
    triggersSuppressedByDebounce: 0,
    candidateTxBuildAttempts: 0,
    successfulSimulations: 0,
    failedSimulationsByClass: {
      SIM_OK: 0,
      SIM_RPC_ERROR: 0,
      SIM_ACCOUNT_MISSING: 0,
      SIM_QUOTE_STALE: 0,
      SIM_SLIPPAGE_EXCEEDED: 0,
      SIM_TOKEN2022_ACCOUNT_MISMATCH: 0,
      SIM_RECEIPT_CONFIG_ERROR: 0,
      SIM_UNKNOWN: 0,
    },
    quoteAgeTotalMs: 0,
    quoteAgeCount: 0,
    triggerDelayTotalMs: 0,
    triggerDelayCount: 0,
    triggerUpCount: 0,
    triggerDownCount: 0,
  };
}

function aggregateSimulationClass(metrics: ShadowMetrics, klass: ShadowSimulationClass): void {
  if (klass === 'SIM_OK') {
    metrics.successfulSimulations += 1;
    return;
  }
  metrics.failedSimulationsByClass[klass] += 1;
}

export function buildShadowTriggerRecord(params: {
  sessionId: string;
  timestamp: string;
  config: AutopilotConfig;
  authority: PublicKey;
  positionAddress: string;
  positionSourceMode: PositionSourceMode;
  refresh: NonNullable<Awaited<ReturnType<typeof executeOnce>>['refresh']>;
  result: Awaited<ReturnType<typeof executeOnce>>;
  simClass: ShadowSimulationClass;
  normalizedError: { code?: CanonicalErrorCode } | null;
}): ShadowTriggerRecord {
  const wouldExecute = params.simClass === 'SIM_OK';
  return {
    sessionId: params.sessionId,
    timestamp: params.timestamp,
    cluster: params.config.cluster,
    executionMode: params.config.executionMode,
    positionAddress: params.positionAddress,
    authority: params.authority.toBase58(),
    whirlpoolAddress: params.refresh.snapshot.whirlpoolAddress,
    direction: params.refresh.decision.decision === 'TRIGGER_UP' ? 'trigger_up' : 'trigger_down',
    currentTick: params.refresh.snapshot.currentTick,
    lowerTick: params.refresh.snapshot.lowerTick,
    upperTick: params.refresh.snapshot.upperTick,
    debounceCount: params.refresh.decision.samplesUsed,
    swapRouter: params.config.execution.swapRouter,
    quoteInAmount: params.result.shadow?.quoteSummary.inAmount ?? '0',
    quoteMinOut: params.result.shadow?.quoteSummary.minOut ?? '0',
    slippageBps: params.result.shadow?.quoteSummary.slippageBps ?? params.config.execution.slippageBpsCap,
    quoteAgeMs: params.result.shadow?.quoteSummary.quoteAgeMs ?? 0,
    txBuildStatus: params.result.shadow?.txBuildStatus ?? 'BUILD_FAILED',
    simulationStatus: params.simClass,
    simulationErrorCode: params.normalizedError?.code,
    candidateInstructionSummaryJson: JSON.stringify(params.result.shadow?.candidateInstructionSummary ?? {}),
    wouldExecute,
    wouldFailReason: wouldExecute ? undefined : params.result.errorCode ?? 'SIMULATION_OR_BUILD_FAILED',
    receiptPdaExpected: params.result.shadow?.receiptPdaExpected,
    receiptConfigValid: params.result.shadow?.receiptConfigValid ?? false,
    receiptStepStructurallyBuildable: params.result.shadow?.receiptStepStructurallyBuildable ?? false,
    receiptIxIncluded: params.result.shadow?.receiptIxIncluded ?? false,
    mintAProgram: params.refresh.snapshot.tokenProgramA,
    mintBProgram: params.refresh.snapshot.tokenProgramB,
    positionSourceMode: params.positionSourceMode,
  };
}

async function captureSample(connection: Connection, position: PublicKey, config: AutopilotConfig, state: PositionRuntimeState): Promise<void> {
  const snapshot: PositionSnapshot = await loadPositionSnapshot(connection, position, config.cluster);
  const slot = await connection.getSlot('confirmed');
  const unixTs = Math.floor(Date.now() / 1000);
  state.samples = [...state.samples, { slot, unixTs, currentTickIndex: snapshot.currentTickIndex }].slice(
    -config.ui.sampleBufferSize,
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runMainnetShadow(env: Record<string, string | undefined> = process.env): Promise<void> {
  const config = loadShadowConfig(env);
  const rpcUrl = env.SOLANA_RPC_URL ?? env.RPC_URL;
  if (!rpcUrl) throw new Error('CONFIG_INVALID: SOLANA_RPC_URL or RPC_URL is required');

  const authorityRaw = env.SHADOW_AUTHORITY ?? env.AUTHORITY_PUBKEY ?? env.AUTHORITY;
  if (!authorityRaw) throw new Error('CONFIG_INVALID: SHADOW_AUTHORITY (or AUTHORITY_PUBKEY) is required');
  const authority = new PublicKey(authorityRaw);

  const configuredPositions = parsePositionList(env.SHADOW_POSITION_ADDRESSES ?? env.POSITION_ADDRESSES);
  const discoveryEnabled = parseBoolean(env.SHADOW_DISCOVER_POSITIONS, false);

  const connection = new Connection(rpcUrl, 'confirmed');
  const receiptIdentity = config.execution.onChainReceiptEnabled
    ? resolveReceiptRuntimeIdentity(config, env)
    : null;
  if (config.execution.onChainReceiptEnabled) {
    if (!receiptIdentity) {
      fail(
        'RECEIPT_CONFIG_INCOMPLETE_FOR_SHADOW',
        'Shadow mode receipt identity must be configured via manifest or config before startup',
      );
    }
    await verifyReceiptProgramOnChain(connection, receiptIdentity);
  }
  let positions = configuredPositions;
  let positionSourceMode: PositionSourceMode = 'configured';
  if (positions.length === 0) {
    if (!discoveryEnabled) {
      throw new Error('CONFIG_INVALID: no positions configured; set SHADOW_POSITION_ADDRESSES or enable SHADOW_DISCOVER_POSITIONS');
    }
    positions = await discoverPositions(connection, new PublicKey(env.SHADOW_DISCOVERY_WALLET ?? authority.toBase58()));
    positionSourceMode = 'discovered';
  }
  if (positions.length === 0) {
    throw new Error('CONFIG_INVALID: no monitorable positions found');
  }

  const dbPath = resolve(env.SHADOW_DB_PATH ?? 'artifacts/shadow/mainnet/shadow.db');
  mkdirSync(resolve(dbPath, '..'), { recursive: true });
  const store = new ShadowArtifactStore(dbPath);
  const counters = createRuntimeCounterRegistry();
  const rollupEveryEvaluations = parseInteger(env.SHADOW_ROLLUP_EVERY_EVALS, 50);
  const sessionId = createSessionId(authority, positions);
  store.insertRunSession({
    sessionId,
    startedAt: new Date().toISOString(),
    stateColdStart: true,
    positionSourceMode,
  });

  const states = new Map<string, PositionRuntimeState>();
  for (const position of positions) {
    states.set(position.toBase58(), {
      samples: [],
      policyState: {},
      coldStartPending: true,
      evaluationCount: 0,
    });
  }

  const metrics = initializeMetrics();
  let running = true;
  const stop = () => {
    running = false;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: 'shadow.start',
      banner: 'MAINNET SHADOW MODE',
      sessionId,
      positionCount: positions.length,
      positionSourceMode,
      dbPath,
      localReceiptDbPath: config.execution.localReceiptDbPath ?? null,
      onChainReceiptEnabled: config.execution.onChainReceiptEnabled,
      executionMode: config.executionMode,
      cluster: config.cluster,
    }),
  );

  try {
    while (running) {
      for (const position of positions) {
        if (!running) break;
        const positionAddress = position.toBase58();
        const state = states.get(positionAddress)!;

        try {
          await captureSample(connection, position, config, state);
          const result = await executeOnce({
            connection,
            authority,
            position,
            samples: state.samples,
            config,
            policyState: state.policyState,
            expectedMinOut: 'N/A',
            quoteAgeMs: 0,
            counters,
            runtimeEnvironment: {
              rpcUrl,
              commitment: 'confirmed',
              walletConnected: false,
              signingAvailable: false,
            },
            receiptIdentityEnv: env,
            transport: new ShadowSubmitter(config.executionMode),
          });

          if (result.status === 'ERROR' && !result.refresh) {
            const normalized = normalizeSolanaError({
              code: result.errorCode,
              message: result.errorMessage,
              debug: result.errorDebug,
            });
            if (isFatalShadowStartupCode(normalized.code as CanonicalErrorCode | undefined)) {
              throw normalized;
            }
            console.error(
              JSON.stringify({
                ts: new Date().toISOString(),
                event: 'shadow.position_failed',
                position: positionAddress,
                code: normalized.code,
                message: normalized.message,
              }),
            );
            continue;
          }

          if (result.refresh?.decision.nextState) {
            state.policyState = result.refresh.decision.nextState;
          }

          const refresh = result.refresh;
          if (!refresh) continue;

          metrics.monitoredEvaluations += 1;
          state.evaluationCount += 1;

          const evaluationSignature = toEvaluationSignature(refresh.decision);
          const sampledCheckpoint = state.evaluationCount % rollupEveryEvaluations === 0;
          const shouldPersistEvaluation =
            state.coldStartPending ||
            sampledCheckpoint ||
            state.lastEvaluationSignature !== evaluationSignature;

          if (refresh.snapshot.inRange) {
            state.firstOutOfRangeAtUnixMs = undefined;
          } else if (!state.firstOutOfRangeAtUnixMs) {
            state.firstOutOfRangeAtUnixMs = Date.now();
          }

          if (shouldPersistEvaluation) {
            store.insertEvaluation({
              sessionId,
              timestamp: new Date().toISOString(),
              cluster: config.cluster,
              executionMode: config.executionMode,
              positionAddress,
              authority: authority.toBase58(),
              whirlpoolAddress: refresh.snapshot.whirlpoolAddress,
              decision: refresh.decision.decision,
              reasonCode: refresh.decision.reasonCode,
              debounceCount: refresh.decision.samplesUsed,
              stateColdStart: state.coldStartPending,
              sampledCheckpoint,
              positionSourceMode,
            });
          }

          state.coldStartPending = false;
          state.lastEvaluationSignature = evaluationSignature;

          const isTrigger = refresh.decision.decision === 'TRIGGER_UP' || refresh.decision.decision === 'TRIGGER_DOWN';
          if (!isTrigger) {
            if (isDebounceSuppression(refresh.decision.reasonCode)) {
              metrics.triggersSuppressedByDebounce += 1;
            }
          } else {
            metrics.triggersFired += 1;
            metrics.candidateTxBuildAttempts += 1;
            if (refresh.decision.decision === 'TRIGGER_UP') metrics.triggerUpCount += 1;
            if (refresh.decision.decision === 'TRIGGER_DOWN') metrics.triggerDownCount += 1;

            const normalized =
              result.status === 'ERROR' && result.errorCode
                ? normalizeSolanaError({
                    code: result.errorCode,
                    message: result.errorMessage,
                    debug: result.errorDebug,
                  })
                : null;
            const simClass = classifyShadowSimulationResult({
              status: result.status,
              error: normalized,
            });
            aggregateSimulationClass(metrics, simClass);

            if (result.shadow?.quoteSummary.quoteAgeMs !== undefined) {
              metrics.quoteAgeTotalMs += result.shadow.quoteSummary.quoteAgeMs;
              metrics.quoteAgeCount += 1;
            }

            if (state.firstOutOfRangeAtUnixMs) {
              metrics.triggerDelayTotalMs += Math.max(0, Date.now() - state.firstOutOfRangeAtUnixMs);
              metrics.triggerDelayCount += 1;
              state.firstOutOfRangeAtUnixMs = undefined;
            }

            store.insertTrigger(
              buildShadowTriggerRecord({
                sessionId,
                timestamp: new Date().toISOString(),
                config,
                authority,
                positionAddress,
                positionSourceMode,
                refresh,
                result,
                simClass,
                normalizedError: normalized?.code ? { code: normalized.code as CanonicalErrorCode } : null,
              }),
            );
          }

          if (metrics.monitoredEvaluations % rollupEveryEvaluations === 0) {
            const snapshot = counters.snapshot();
            store.insertRollup({
              sessionId,
              timestamp: new Date().toISOString(),
              monitoredEvaluations: metrics.monitoredEvaluations,
              triggersFired: metrics.triggersFired,
              triggersSuppressedByDebounce: metrics.triggersSuppressedByDebounce,
              candidateTxBuildAttempts: metrics.candidateTxBuildAttempts,
              successfulSimulations: metrics.successfulSimulations,
              failedSimulationsByClassJson: JSON.stringify(metrics.failedSimulationsByClass),
              averageQuoteAgeMs: metrics.quoteAgeCount ? metrics.quoteAgeTotalMs / metrics.quoteAgeCount : 0,
              averageTriggerDelayMs: metrics.triggerDelayCount
                ? metrics.triggerDelayTotalMs / metrics.triggerDelayCount
                : 0,
              triggerUpCount: metrics.triggerUpCount,
              triggerDownCount: metrics.triggerDownCount,
              signerInvocations: snapshot.signerInvocations,
              submitInvocations: snapshot.submitInvocations,
              walletPromptCount: snapshot.walletPromptCount,
              shadowTxSignaturesEmitted: snapshot.shadowTxSignaturesEmitted,
            });
          }
        } catch (error) {
          const normalized = normalizeSolanaError(error);
          console.error(
            JSON.stringify({
              ts: new Date().toISOString(),
              event: 'shadow.position_failed',
              position: positionAddress,
              code: normalized.code,
              message: normalized.message,
            }),
          );
          if (isFatalShadowStartupCode(normalized.code as CanonicalErrorCode | undefined)) {
            throw normalized;
          }
        }
      }

      await sleep(config.policy.cadenceMs);
    }
  } finally {
    const snapshot = counters.snapshot();
    store.insertRollup({
      sessionId,
      timestamp: new Date().toISOString(),
      monitoredEvaluations: metrics.monitoredEvaluations,
      triggersFired: metrics.triggersFired,
      triggersSuppressedByDebounce: metrics.triggersSuppressedByDebounce,
      candidateTxBuildAttempts: metrics.candidateTxBuildAttempts,
      successfulSimulations: metrics.successfulSimulations,
      failedSimulationsByClassJson: JSON.stringify(metrics.failedSimulationsByClass),
      averageQuoteAgeMs: metrics.quoteAgeCount ? metrics.quoteAgeTotalMs / metrics.quoteAgeCount : 0,
      averageTriggerDelayMs: metrics.triggerDelayCount ? metrics.triggerDelayTotalMs / metrics.triggerDelayCount : 0,
      triggerUpCount: metrics.triggerUpCount,
      triggerDownCount: metrics.triggerDownCount,
      signerInvocations: snapshot.signerInvocations,
      submitInvocations: snapshot.submitInvocations,
      walletPromptCount: snapshot.walletPromptCount,
      shadowTxSignaturesEmitted: snapshot.shadowTxSignaturesEmitted,
    });
    store.close();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
