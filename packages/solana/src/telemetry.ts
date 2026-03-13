import type { Cluster, ExecutionMode, RuntimeMode, SwapRouter } from '@clmm-autopilot/core';
import type { CanonicalErrorCode } from './types';

export type RuntimeEventName =
  | 'monitor.snapshot_fetched'
  | 'monitor.snapshot_failed'
  | 'policy.decision_hold'
  | 'policy.decision_trigger_up'
  | 'policy.decision_trigger_down'
  | 'policy.cooldown_active'
  | 'execution.mode_blocked'
  | 'execution.build_started'
  | 'execution.build_failed'
  | 'execution.simulation_started'
  | 'execution.simulation_failed'
  | 'execution.send_started'
  | 'execution.send_confirmed'
  | 'execution.send_failed'
  | 'execution.receipt_precheck_zero'
  | 'execution.receipt_precheck_exists'
  | 'execution.receipt_verified'
  | 'execution.swap_skipped_dust'
  | 'execution.paused_block'
  | 'config.validation_failed';

export type RuntimeEventStatus = 'started' | 'ok' | 'failed' | 'blocked' | 'hypothetical';

export type RuntimeEvent = {
  event: RuntimeEventName;
  timestamp: string;
  cluster: Cluster;
  executionMode: ExecutionMode;
  runtimeMode: RuntimeMode;
  executionPaused: boolean;
  authority?: string;
  position?: string;
  whirlpool?: string;
  router?: SwapRouter;
  direction?: 'UP' | 'DOWN';
  correlationId: string;
  status: RuntimeEventStatus;
  errorCode?: CanonicalErrorCode;
  details?: Record<string, unknown>;
};

export type RuntimeObserver = {
  emit: (event: RuntimeEvent) => void;
};

export type RuntimeCounterSnapshot = {
  snapshotsFetched: number;
  snapshotFailures: number;
  triggerUpCount: number;
  triggerDownCount: number;
  buildAttempts: number;
  buildFailures: number;
  simulationAttempts: number;
  simulationFailures: number;
  sendAttempts: number;
  sendConfirmations: number;
  sendFailures: number;
  receiptExistsPrecheckCount: number;
  receiptWrittenCount: number;
  swapSkippedCount: number;
  pausedBlocks: number;
  configValidationFailures: number;
  signerInvocations: number;
  submitInvocations: number;
  walletPromptCount: number;
  shadowTxSignaturesEmitted: number;
};

export type RuntimeCounterRegistry = {
  increment: (name: keyof RuntimeCounterSnapshot) => void;
  snapshot: () => RuntimeCounterSnapshot;
  recordEvent: (event: RuntimeEvent) => void;
};

const zeroCounters = (): RuntimeCounterSnapshot => ({
  snapshotsFetched: 0,
  snapshotFailures: 0,
  triggerUpCount: 0,
  triggerDownCount: 0,
  buildAttempts: 0,
  buildFailures: 0,
  simulationAttempts: 0,
  simulationFailures: 0,
  sendAttempts: 0,
  sendConfirmations: 0,
  sendFailures: 0,
  receiptExistsPrecheckCount: 0,
  receiptWrittenCount: 0,
  swapSkippedCount: 0,
  pausedBlocks: 0,
  configValidationFailures: 0,
  signerInvocations: 0,
  submitInvocations: 0,
  walletPromptCount: 0,
  shadowTxSignaturesEmitted: 0,
});

export function createRuntimeCounterRegistry(): RuntimeCounterRegistry {
  const counters = zeroCounters();

  return {
    increment(name) {
      counters[name] += 1;
    },
    snapshot() {
      return { ...counters };
    },
    recordEvent(event) {
      switch (event.event) {
        case 'monitor.snapshot_fetched':
          counters.snapshotsFetched += 1;
          break;
        case 'monitor.snapshot_failed':
          counters.snapshotFailures += 1;
          break;
        case 'policy.decision_trigger_up':
          counters.triggerUpCount += 1;
          break;
        case 'policy.decision_trigger_down':
          counters.triggerDownCount += 1;
          break;
        case 'execution.build_started':
          counters.buildAttempts += 1;
          break;
        case 'execution.build_failed':
          counters.buildFailures += 1;
          break;
        case 'execution.simulation_started':
          counters.simulationAttempts += 1;
          break;
        case 'execution.simulation_failed':
          counters.simulationFailures += 1;
          break;
        case 'execution.send_started':
          counters.sendAttempts += 1;
          break;
        case 'execution.send_confirmed':
          counters.sendConfirmations += 1;
          break;
        case 'execution.send_failed':
          counters.sendFailures += 1;
          break;
        case 'execution.receipt_precheck_exists':
          counters.receiptExistsPrecheckCount += 1;
          break;
        case 'execution.receipt_verified':
          counters.receiptWrittenCount += 1;
          break;
        case 'execution.swap_skipped_dust':
          counters.swapSkippedCount += 1;
          break;
        case 'execution.paused_block':
          counters.pausedBlocks += 1;
          break;
        case 'config.validation_failed':
          counters.configValidationFailures += 1;
          break;
      }
    },
  };
}

export function createCorrelationId(): string {
  return `rt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function emitRuntimeEvent(
  observer: RuntimeObserver | undefined,
  counters: RuntimeCounterRegistry | undefined,
  event: RuntimeEvent,
): RuntimeEvent {
  observer?.emit(event);
  counters?.recordEvent(event);
  return event;
}
