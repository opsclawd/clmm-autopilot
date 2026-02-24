export type AutopilotConfig = {
  policy: {
    cadenceMs: number;
    requiredConsecutive: number;
    cooldownMs: number;
  };
  execution: {
    maxSlippageBps: number;
    quoteFreshnessMs: number;
    maxRebuildAttempts: number;
    rebuildWindowMs: number;
    computeUnitLimit: number;
    computeUnitPriceMicroLamports: number;
    txFeeLamports: number;
    feeBufferLamports: number;
  };
  reliability: {
    fetchMaxAttempts: number;
    retryBackoffMs: number[];
    maxSlotDrift: number;
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
    rebuildWindowMs: 15_000,
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

export type ConfigErrorCode = 'TYPE' | 'RANGE' | 'INVALID_BACKOFF_SCHEDULE';

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

function pushRange(errors: ConfigError[], path: string, expected: string, actual: unknown): void {
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

function readIntField(
  errors: ConfigError[],
  source: Record<string, unknown>,
  key: string,
  path: string,
  fallback: number,
): number {
  if (!(key in source)) return fallback;
  const raw = source[key];
  const n = coerceNumber(raw);
  if (n === undefined) {
    pushType(errors, path, 'number/integer', raw);
    return fallback;
  }
  return Math.trunc(n);
}

function normalizeAutopilotConfig(input: unknown): ValidateConfigResult {
  if (input === undefined) return { ok: true, value: DEFAULT_CONFIG };
  if (!isRecord(input)) {
    return {
      ok: false,
      errors: [
        {
          path: '$',
          code: 'TYPE',
          message: 'Config root must be an object',
          expected: 'object',
          actual: input,
        },
      ],
    };
  }

  const errors: ConfigError[] = [];
  const policyInRaw = input.policy;
  const executionInRaw = input.execution;
  const reliabilityInRaw = input.reliability;

  const policyIn =
    policyInRaw === undefined
      ? {}
      : isRecord(policyInRaw)
        ? policyInRaw
        : (pushType(errors, 'policy', 'object', policyInRaw), {});
  const executionIn =
    executionInRaw === undefined
      ? {}
      : isRecord(executionInRaw)
        ? executionInRaw
        : (pushType(errors, 'execution', 'object', executionInRaw), {});
  const reliabilityIn =
    reliabilityInRaw === undefined
      ? {}
      : isRecord(reliabilityInRaw)
        ? reliabilityInRaw
        : (pushType(errors, 'reliability', 'object', reliabilityInRaw), {});

  const retryRaw = reliabilityIn.retryBackoffMs;
  let retryBackoffMs = DEFAULT_CONFIG.reliability.retryBackoffMs;
  if (retryRaw !== undefined) {
    if (!Array.isArray(retryRaw)) {
      pushType(errors, 'reliability.retryBackoffMs', 'number[]', retryRaw);
    } else {
      const converted: number[] = [];
      for (let i = 0; i < retryRaw.length; i += 1) {
        const item = retryRaw[i];
        const n = coerceNumber(item);
        if (n === undefined) {
          pushType(errors, `reliability.retryBackoffMs[${i}]`, 'number/integer', item);
          continue;
        }
        converted.push(Math.trunc(n));
      }
      retryBackoffMs = converted;
    }
  }

  const normalized: AutopilotConfig = {
    policy: {
      cadenceMs: readIntField(errors, policyIn, 'cadenceMs', 'policy.cadenceMs', DEFAULT_CONFIG.policy.cadenceMs),
      requiredConsecutive: readIntField(
        errors,
        policyIn,
        'requiredConsecutive',
        'policy.requiredConsecutive',
        DEFAULT_CONFIG.policy.requiredConsecutive,
      ),
      cooldownMs: readIntField(errors, policyIn, 'cooldownMs', 'policy.cooldownMs', DEFAULT_CONFIG.policy.cooldownMs),
    },
    execution: {
      maxSlippageBps: readIntField(
        errors,
        executionIn,
        'maxSlippageBps',
        'execution.maxSlippageBps',
        DEFAULT_CONFIG.execution.maxSlippageBps,
      ),
      quoteFreshnessMs: readIntField(
        errors,
        executionIn,
        'quoteFreshnessMs',
        'execution.quoteFreshnessMs',
        DEFAULT_CONFIG.execution.quoteFreshnessMs,
      ),
      maxRebuildAttempts: readIntField(
        errors,
        executionIn,
        'maxRebuildAttempts',
        'execution.maxRebuildAttempts',
        DEFAULT_CONFIG.execution.maxRebuildAttempts,
      ),
      rebuildWindowMs: readIntField(
        errors,
        executionIn,
        'rebuildWindowMs',
        'execution.rebuildWindowMs',
        DEFAULT_CONFIG.execution.rebuildWindowMs,
      ),
      computeUnitLimit: readIntField(
        errors,
        executionIn,
        'computeUnitLimit',
        'execution.computeUnitLimit',
        DEFAULT_CONFIG.execution.computeUnitLimit,
      ),
      computeUnitPriceMicroLamports: readIntField(
        errors,
        executionIn,
        'computeUnitPriceMicroLamports',
        'execution.computeUnitPriceMicroLamports',
        DEFAULT_CONFIG.execution.computeUnitPriceMicroLamports,
      ),
      txFeeLamports: readIntField(
        errors,
        executionIn,
        'txFeeLamports',
        'execution.txFeeLamports',
        DEFAULT_CONFIG.execution.txFeeLamports,
      ),
      feeBufferLamports: readIntField(
        errors,
        executionIn,
        'feeBufferLamports',
        'execution.feeBufferLamports',
        DEFAULT_CONFIG.execution.feeBufferLamports,
      ),
    },
    reliability: {
      fetchMaxAttempts: readIntField(
        errors,
        reliabilityIn,
        'fetchMaxAttempts',
        'reliability.fetchMaxAttempts',
        DEFAULT_CONFIG.reliability.fetchMaxAttempts,
      ),
      retryBackoffMs,
      maxSlotDrift: readIntField(
        errors,
        reliabilityIn,
        'maxSlotDrift',
        'reliability.maxSlotDrift',
        DEFAULT_CONFIG.reliability.maxSlotDrift,
      ),
      sendMaxAttempts: readIntField(
        errors,
        reliabilityIn,
        'sendMaxAttempts',
        'reliability.sendMaxAttempts',
        DEFAULT_CONFIG.reliability.sendMaxAttempts,
      ),
    },
  };

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: normalized };
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
  if (!normalized.ok) return normalized;

  const errors: ConfigError[] = [];
  const p = normalized.value.policy;
  if (!Number.isInteger(p.cadenceMs)) pushType(errors, 'policy.cadenceMs', 'integer', p.cadenceMs);
  else if (p.cadenceMs <= 0) pushRange(errors, 'policy.cadenceMs', '> 0', p.cadenceMs);

  if (!Number.isInteger(p.requiredConsecutive)) pushType(errors, 'policy.requiredConsecutive', 'integer', p.requiredConsecutive);
  else if (p.requiredConsecutive <= 0) pushRange(errors, 'policy.requiredConsecutive', '> 0', p.requiredConsecutive);

  if (!Number.isInteger(p.cooldownMs)) pushType(errors, 'policy.cooldownMs', 'integer', p.cooldownMs);
  else if (p.cooldownMs < 0) pushRange(errors, 'policy.cooldownMs', '>= 0', p.cooldownMs);

  const e = normalized.value.execution;
  if (!Number.isInteger(e.maxSlippageBps)) pushType(errors, 'execution.maxSlippageBps', 'integer', e.maxSlippageBps);
  else if (e.maxSlippageBps < 0 || e.maxSlippageBps > 50) pushRange(errors, 'execution.maxSlippageBps', '0..50 (bps)', e.maxSlippageBps);

  if (!Number.isInteger(e.quoteFreshnessMs)) pushType(errors, 'execution.quoteFreshnessMs', 'integer', e.quoteFreshnessMs);
  else if (e.quoteFreshnessMs <= 0) pushRange(errors, 'execution.quoteFreshnessMs', '> 0', e.quoteFreshnessMs);

  if (!Number.isInteger(e.maxRebuildAttempts)) pushType(errors, 'execution.maxRebuildAttempts', 'integer', e.maxRebuildAttempts);
  else if (e.maxRebuildAttempts < 0 || e.maxRebuildAttempts > 10) pushRange(errors, 'execution.maxRebuildAttempts', '0..10', e.maxRebuildAttempts);

  if (!Number.isInteger(e.rebuildWindowMs)) pushType(errors, 'execution.rebuildWindowMs', 'integer', e.rebuildWindowMs);
  else if (e.rebuildWindowMs <= 0) pushRange(errors, 'execution.rebuildWindowMs', '> 0', e.rebuildWindowMs);

  if (!Number.isInteger(e.computeUnitLimit)) pushType(errors, 'execution.computeUnitLimit', 'integer', e.computeUnitLimit);
  else if (e.computeUnitLimit <= 0) pushRange(errors, 'execution.computeUnitLimit', '> 0', e.computeUnitLimit);

  if (!Number.isInteger(e.computeUnitPriceMicroLamports)) pushType(errors, 'execution.computeUnitPriceMicroLamports', 'integer', e.computeUnitPriceMicroLamports);
  else if (e.computeUnitPriceMicroLamports < 0) pushRange(errors, 'execution.computeUnitPriceMicroLamports', '>= 0', e.computeUnitPriceMicroLamports);

  if (!Number.isInteger(e.txFeeLamports)) pushType(errors, 'execution.txFeeLamports', 'integer', e.txFeeLamports);
  else if (e.txFeeLamports < 0) pushRange(errors, 'execution.txFeeLamports', '>= 0', e.txFeeLamports);

  if (!Number.isInteger(e.feeBufferLamports)) pushType(errors, 'execution.feeBufferLamports', 'integer', e.feeBufferLamports);
  else if (e.feeBufferLamports < 0) pushRange(errors, 'execution.feeBufferLamports', '>= 0', e.feeBufferLamports);

  const r = normalized.value.reliability;
  if (!Number.isInteger(r.fetchMaxAttempts)) pushType(errors, 'reliability.fetchMaxAttempts', 'integer', r.fetchMaxAttempts);
  else if (r.fetchMaxAttempts <= 0 || r.fetchMaxAttempts > 10) pushRange(errors, 'reliability.fetchMaxAttempts', '1..10', r.fetchMaxAttempts);

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
  return normalized;
}
