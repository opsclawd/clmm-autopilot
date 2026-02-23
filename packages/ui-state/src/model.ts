export type UiSnapshot = {
  positionAddress: string;
  currentTick: number;
  lowerTick: number;
  upperTick: number;
  inRange: boolean;
  slot?: number;
  unixTs?: number;
};

export type UiDecision = {
  decision: 'HOLD' | 'TRIGGER_DOWN' | 'TRIGGER_UP';
  reasonCode: string;
  samplesUsed: number;
  threshold: number;
  cooldownRemainingMs: number;
};

export type UiQuote = {
  slippageBpsCap: number;
  expectedMinOut: string;
  quoteAgeMs: number;
  route?: string;
};

export type UiExecution = {
  unsignedTxBuilt: boolean;
  simulated: boolean;
  simLogs?: string[];
  sendSig?: string;
  receiptPda?: string;
  receiptFetched?: boolean;
  receiptFields?: string;
};

export type UiModel = {
  loading: {
    snapshot: boolean;
    decision: boolean;
    quote: boolean;
    execute: boolean;
  };
  snapshot?: UiSnapshot;
  decision?: UiDecision;
  quote?: UiQuote;
  execution?: UiExecution;
  canExecute: boolean;
  lastError?: string;
};

export function buildUiModel(input: {
  snapshot?: UiSnapshot;
  decision?: UiDecision;
  quote?: UiQuote;
  execution?: UiExecution;
  lastError?: string;
  loading?: Partial<UiModel['loading']>;
}): UiModel {
  return {
    loading: {
      snapshot: input.loading?.snapshot ?? false,
      decision: input.loading?.decision ?? false,
      quote: input.loading?.quote ?? false,
      execute: input.loading?.execute ?? false,
    },
    snapshot: input.snapshot,
    decision: input.decision,
    quote: input.quote,
    execution: input.execution,
    canExecute: input.decision ? input.decision.decision !== 'HOLD' : false,
    lastError: input.lastError,
  };
}

export const applySnapshot = (prev: UiModel, snapshot: UiSnapshot): UiModel =>
  buildUiModel({ ...prev, snapshot });

export const applyDecision = (prev: UiModel, decision: UiDecision): UiModel =>
  buildUiModel({ ...prev, decision });

export const applyQuote = (prev: UiModel, quote: UiQuote): UiModel =>
  buildUiModel({ ...prev, quote });

export const applyExecutionResult = (prev: UiModel, execution: UiExecution): UiModel =>
  buildUiModel({ ...prev, execution });

export const applyError = (prev: UiModel, lastError: string): UiModel =>
  buildUiModel({ ...prev, lastError });
