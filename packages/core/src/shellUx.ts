import type { Decision } from './policy';

export type ShellQuoteMeta = {
  slippageCapBps: number;
  expectedMinOut: string;
  quoteAgeMs: number;
};

export type ShellSnapshotView = {
  currentTickIndex: number;
  lowerTickIndex: number;
  upperTickIndex: number;
};

export type ShellUiState = {
  decision: Decision['action'];
  reasonCode: Decision['reasonCode'];
  debounceProgress: string;
  cooldownRemainingMs: number;
  quote: ShellQuoteMeta;
  snapshot: ShellSnapshotView;
  canExecute: boolean;
};

export function buildShellUiState(input: {
  decision: Decision;
  quote: ShellQuoteMeta;
  snapshot: ShellSnapshotView;
}): ShellUiState {
  const thresholdSamples = Math.max(1, Math.floor(input.decision.debug.threshold / 2000));
  const pending = input.decision.action === 'HOLD' ? `${Math.min(input.decision.debug.samplesUsed, thresholdSamples)}/${thresholdSamples}` : `${thresholdSamples}/${thresholdSamples}`;

  return {
    decision: input.decision.action,
    reasonCode: input.decision.reasonCode,
    debounceProgress: pending,
    cooldownRemainingMs: input.decision.debug.cooldownRemainingMs,
    quote: input.quote,
    snapshot: input.snapshot,
    canExecute: input.decision.action !== 'HOLD',
  };
}
