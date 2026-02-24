export type AutopilotConfig = {
  policy: {
    // Policy sampling cadence in milliseconds.
    cadenceMs: number;
    // Consecutive out-of-range samples required to trigger.
    requiredConsecutive: number;
    // Cooldown after any trigger.
    cooldownMs: number;
  };
  execution: {
    // Hard slippage cap for Jupiter quotes.
    maxSlippageBps: number;
    // Quote age allowed before triggering a rebuild.
    quoteFreshnessMs: number;
    // How many times the builder may attempt to rebuild snapshot+quote to satisfy freshness.
    maxRebuildAttempts: number;

    // Compute budget (required by SPEC).
    computeUnitLimit: number;
    computeUnitPriceMicroLamports: number;

    // Fee guardrails (lamports).
    txFeeLamports: number;
    feeBufferLamports: number;
  };
  reliability: {
    // Max attempts for bounded retries on fetch/RPC reads.
    fetchMaxAttempts: number;
    // Backoff schedule for retries.
    retryBackoffMs: number[];

    // Rebuild heuristics.
    maxSlotDrift: number;

    // Send retry policy: max retries for clearly transient send failures.
    sendMaxAttempts: number;
  };
};

export const DEFAULT_CONFIG: AutopilotConfig = {
  policy: {
    cadenceMs: 2_000,
    requiredConsecutive: 3,
    cooldownMs: 90_000,
  },
  execution: {
    maxSlippageBps: 50,
    quoteFreshnessMs: 20_000,
    maxRebuildAttempts: 3,
    computeUnitLimit: 600_000,
    computeUnitPriceMicroLamports: 10_000,
    txFeeLamports: 20_000,
    feeBufferLamports: 10_000_000,
  },
  reliability: {
    fetchMaxAttempts: 3,
    retryBackoffMs: [250, 750, 2_000],
    maxSlotDrift: 8,
    sendMaxAttempts: 2,
  },
};

export type ConfigErrorCode =
  | 'REQUIRED'
  | 'TYPE'
  | 'RANGE'
  | 'INVALID_BACKOFF_SCHEDULE';

export type ConfigError = {
  path: string;
  code: ConfigErrorCode;
  message: string;
  expected?: string;
  actual?: unknown;
};

export type ValidateConfigResult =
  | { ok: true; value: AutopilotConfig }
  | { ok: false; errors: ConfigError[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function coerceNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function pushType(errors: ConfigError[], path: string, expected: string, actual: unknown): void {
  errors.push({
    path,
    code: 'TYPE',
    message: 'Invalid type for config value',
    expected,
    actual,
  });
}

function pushRange(
  errors: ConfigError[],
  path: string,
  expected: string,
  actual: unknown,
): void {
  errors.push({
    path,
    code: 'RANGE',
    message: 'Config value is out of allowed range',
    expected,
    actual,
  });
}

function pushBackoff(errors: ConfigError[], path: string, message: string, actual: unknown): void {
  errors.push({
    path,
    code: 'INVALID_BACKOFF_SCHEDULE',
    message,
    expected: 'array of positive integers (strictly increasing)',
    actual,
  });
}

function normalizeAutopilotConfig(input: unknown): AutopilotConfig {
  if (!isRecord(input)) return DEFAULT_CONFIG;

  const policyIn = isRecord(input.policy) ? input.policy : {};
  const execIn = isRecord(input.execution) ? input.execution : {};
  const relIn = isRecord(input.reliability) ? input.reliability : {};

  const retryBackoffMsRaw = relIn.retryBackoffMs;
  const retryBackoffMs = Array.isArray(retryBackoffMsRaw)
    ? retryBackoffMsRaw
        .map(coerceNumber)
        .filter((v): v is number => typeof v === 'number')
        .map((n) => Math.trunc(n))
    : DEFAULT_CONFIG.reliability.retryBackoffMs;

  return {
    policy: {
      cadenceMs: Math.trunc(coerceNumber(policyIn.cadenceMs) ?? DEFAULT_CONFIG.policy.cadenceMs),
      requiredConsecutive: Math.trunc(
        coerceNumber(policyIn.requiredConsecutive) ?? DEFAULT_CONFIG.policy.requiredConsecutive,
      ),
      cooldownMs: Math.trunc(coerceNumber(policyIn.cooldownMs) ?? DEFAULT_CONFIG.policy.cooldownMs),
    },
    execution: {
      maxSlippageBps: Math.trunc(coerceNumber(execIn.maxSlippageBps) ?? DEFAULT_CONFIG.execution.maxSlippageBps),
      quoteFreshnessMs: Math.trunc(
        coerceNumber(execIn.quoteFreshnessMs) ?? DEFAULT_CONFIG.execution.quoteFreshnessMs,
      ),
      maxRebuildAttempts: Math.trunc(
        coerceNumber(execIn.maxRebuildAttempts) ?? DEFAULT_CONFIG.execution.maxRebuildAttempts,
      ),
      computeUnitLimit: Math.trunc(
        coerceNumber(execIn.computeUnitLimit) ?? DEFAULT_CONFIG.execution.computeUnitLimit,
      ),
      computeUnitPriceMicroLamports: Math.trunc(
        coerceNumber(execIn.computeUnitPriceMicroLamports) ?? DEFAULT_CONFIG.execution.computeUnitPriceMicroLamports,
      ),
      txFeeLamports: Math.trunc(coerceNumber(execIn.txFeeLamports) ?? DEFAULT_CONFIG.execution.txFeeLamports),
      feeBufferLamports: Math.trunc(coerceNumber(execIn.feeBufferLamports) ?? DEFAULT_CONFIG.execution.feeBufferLamports),
    },
    reliability: {
      fetchMaxAttempts: Math.trunc(
        coerceNumber(relIn.fetchMaxAttempts) ?? DEFAULT_CONFIG.reliability.fetchMaxAttempts,
      ),
      retryBackoffMs,
      maxSlotDrift: Math.trunc(coerceNumber(relIn.maxSlotDrift) ?? DEFAULT_CONFIG.reliability.maxSlotDrift),
      sendMaxAttempts: Math.trunc(coerceNumber(relIn.sendMaxAttempts) ?? DEFAULT_CONFIG.reliability.sendMaxAttempts),
    },
  };
}

function validateBackoffSchedule(schedule: number[]): string | null {
  if (!Array.isArray(schedule) || schedule.length === 0) return 'Backoff schedule must be a non-empty array';
  for (const v of schedule) {
    if (!Number.isInteger(v) || v <= 0) return 'Backoff schedule entries must be positive integers';
  }
  for (let i = 1; i < schedule.length; i += 1) {
    if (schedule[i] <= schedule[i - 1]) return 'Backoff schedule must be strictly increasing';
  }
  return null;
}

export function validateConfig(input: unknown): ValidateConfigResult {
  const normalized = normalizeAutopilotConfig(input);
  const errors: ConfigError[] = [];

  // Stable ordered checks: policy -> execution -> reliability.
  // policy
  if (!isRecord(input) || !isRecord(input.policy)) {
    // allow missing policy (defaults), but cadenceMs is required to be valid if provided.
  }

  const p = normalized.policy;
  if (!Number.isInteger(p.cadenceMs)) pushType(errors, 'policy.cadenceMs', 'integer', p.cadenceMs);
  else if (p.cadenceMs <= 0) pushRange(errors, 'policy.cadenceMs', '> 0', p.cadenceMs);

  if (!Number.isInteger(p.requiredConsecutive)) pushType(errors, 'policy.requiredConsecutive', 'integer', p.requiredConsecutive);
  else if (p.requiredConsecutive <= 0) pushRange(errors, 'policy.requiredConsecutive', '> 0', p.requiredConsecutive);

  if (!Number.isInteger(p.cooldownMs)) pushType(errors, 'policy.cooldownMs', 'integer', p.cooldownMs);
  else if (p.cooldownMs < 0) pushRange(errors, 'policy.cooldownMs', '>= 0', p.cooldownMs);

  // execution
  const e = normalized.execution;
  if (!Number.isInteger(e.maxSlippageBps)) pushType(errors, 'execution.maxSlippageBps', 'integer', e.maxSlippageBps);
  else if (e.maxSlippageBps < 0 || e.maxSlippageBps > 50) {
    pushRange(errors, 'execution.maxSlippageBps', '0..50 (bps)', e.maxSlippageBps);
  }

  if (!Number.isInteger(e.quoteFreshnessMs)) pushType(errors, 'execution.quoteFreshnessMs', 'integer', e.quoteFreshnessMs);
  else if (e.quoteFreshnessMs <= 0) pushRange(errors, 'execution.quoteFreshnessMs', '> 0', e.quoteFreshnessMs);

  if (!Number.isInteger(e.maxRebuildAttempts)) pushType(errors, 'execution.maxRebuildAttempts', 'integer', e.maxRebuildAttempts);
  else if (e.maxRebuildAttempts < 0 || e.maxRebuildAttempts > 10) {
    pushRange(errors, 'execution.maxRebuildAttempts', '0..10', e.maxRebuildAttempts);
  }

  if (!Number.isInteger(e.computeUnitLimit)) pushType(errors, 'execution.computeUnitLimit', 'integer', e.computeUnitLimit);
  else if (e.computeUnitLimit <= 0) pushRange(errors, 'execution.computeUnitLimit', '> 0', e.computeUnitLimit);

  if (!Number.isInteger(e.computeUnitPriceMicroLamports)) pushType(errors, 'execution.computeUnitPriceMicroLamports', 'integer', e.computeUnitPriceMicroLamports);
  else if (e.computeUnitPriceMicroLamports < 0) pushRange(errors, 'execution.computeUnitPriceMicroLamports', '>= 0', e.computeUnitPriceMicroLamports);

  if (!Number.isInteger(e.txFeeLamports)) pushType(errors, 'execution.txFeeLamports', 'integer', e.txFeeLamports);
  else if (e.txFeeLamports < 0) pushRange(errors, 'execution.txFeeLamports', '>= 0', e.txFeeLamports);

  if (!Number.isInteger(e.feeBufferLamports)) pushType(errors, 'execution.feeBufferLamports', 'integer', e.feeBufferLamports);
  else if (e.feeBufferLamports < 0) pushRange(errors, 'execution.feeBufferLamports', '>= 0', e.feeBufferLamports);

  // reliability
  const r = normalized.reliability;
  if (!Number.isInteger(r.fetchMaxAttempts)) pushType(errors, 'reliability.fetchMaxAttempts', 'integer', r.fetchMaxAttempts);
  else if (r.fetchMaxAttempts <= 0 || r.fetchMaxAttempts > 10) {
    pushRange(errors, 'reliability.fetchMaxAttempts', '1..10', r.fetchMaxAttempts);
  }

  if (!Array.isArray(r.retryBackoffMs)) {
    pushType(errors, 'reliability.retryBackoffMs', 'number[]', r.retryBackoffMs);
  } else {
    const msg = validateBackoffSchedule(r.retryBackoffMs);
    if (msg) pushBackoff(errors, 'reliability.retryBackoffMs', msg, r.retryBackoffMs);
  }

  if (!Number.isInteger(r.maxSlotDrift)) pushType(errors, 'reliability.maxSlotDrift', 'integer', r.maxSlotDrift);
  else if (r.maxSlotDrift < 0 || r.maxSlotDrift > 128) pushRange(errors, 'reliability.maxSlotDrift', '0..128', r.maxSlotDrift);

  if (!Number.isInteger(r.sendMaxAttempts)) pushType(errors, 'reliability.sendMaxAttempts', 'integer', r.sendMaxAttempts);
  else if (r.sendMaxAttempts < 1 || r.sendMaxAttempts > 3) pushRange(errors, 'reliability.sendMaxAttempts', '1..3', r.sendMaxAttempts);

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: normalized };
}
