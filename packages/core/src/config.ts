export type Cluster = 'devnet' | 'mainnet-beta' | 'localnet';
export type SwapRouter = 'jupiter' | 'orca' | 'noop';

export type AutopilotConfig = {
  cluster: Cluster;
  policy: {
    cadenceMs: number;
    requiredConsecutive: number;
    cooldownMs: number;
  };
  execution: {
    slippageBpsCap: number;
    feeBufferLamports: number;
    txFeeLamports: number;
    computeUnitLimit?: number;
    computeUnitPriceMicroLamports?: number;
    quoteFreshnessSec: number;
    quoteFreshnessSlots: number;
    swapRouter: SwapRouter;
    rebuildTickDelta?: number;
    maxRetries: number;
    retryBackoffMs: number[];
    receiptPollMaxAttempts: number;
    receiptPollIntervalMs: number;
    minSolLamportsToSwap: number;
    minUsdcMinorToSwap: number;
  };
  ui: {
    sampleBufferSize: number;
  };
};

export const DEFAULT_CONFIG: AutopilotConfig = {
  cluster: 'devnet',
  policy: {
    cadenceMs: 2_000,
    requiredConsecutive: 3,
    cooldownMs: 90_000,
  },
  execution: {
    slippageBpsCap: 50,
    txFeeLamports: 20_000,
    feeBufferLamports: 10_000_000,
    computeUnitLimit: 600_000,
    computeUnitPriceMicroLamports: 10_000,
    quoteFreshnessSec: 20,
    quoteFreshnessSlots: 8,
    swapRouter: 'orca',
    rebuildTickDelta: undefined,
    maxRetries: 3,
    retryBackoffMs: [250, 750, 2_000],
    receiptPollMaxAttempts: 6,
    receiptPollIntervalMs: 500,
    minSolLamportsToSwap: 0,
    minUsdcMinorToSwap: 0,
  },
  ui: {
    sampleBufferSize: 90,
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
  errors.push({ path, code: 'TYPE', message: 'Invalid type for config value', expected, actual });
}

function pushRange(errors: ConfigError[], path: string, expected: string, actual: unknown): void {
  errors.push({ path, code: 'RANGE', message: 'Config value is out of allowed range', expected, actual });
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

function readOptionalIntField(
  errors: ConfigError[],
  source: Record<string, unknown>,
  key: string,
  path: string,
  fallback: number | undefined,
): number | undefined {
  if (!(key in source)) return fallback;
  const raw = source[key];
  if (raw === undefined || raw === null) return undefined;
  const n = coerceNumber(raw);
  if (n === undefined) {
    pushType(errors, path, 'number/integer | undefined', raw);
    return fallback;
  }
  return Math.trunc(n);
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

function defaultSwapRouterForCluster(cluster: Cluster): SwapRouter {
  if (cluster === 'mainnet-beta') return 'jupiter';
  if (cluster === 'localnet') return 'noop';
  return 'orca';
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
  const clusterRaw = input.cluster;
  const cluster =
    clusterRaw === undefined
      ? DEFAULT_CONFIG.cluster
      : typeof clusterRaw === 'string'
        ? (clusterRaw as Cluster)
        : (pushType(errors, 'cluster', "'devnet' | 'mainnet-beta' | 'localnet'", clusterRaw), DEFAULT_CONFIG.cluster);

  const policyInRaw = input.policy;
  const executionInRaw = input.execution;
  const uiInRaw = input.ui;

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
  const uiIn =
    uiInRaw === undefined
      ? {}
      : isRecord(uiInRaw)
        ? uiInRaw
        : (pushType(errors, 'ui', 'object', uiInRaw), {});

  const retryRaw = executionIn.retryBackoffMs;
  let retryBackoffMs = DEFAULT_CONFIG.execution.retryBackoffMs;
  if (retryRaw !== undefined) {
    if (!Array.isArray(retryRaw)) {
      pushType(errors, 'execution.retryBackoffMs', 'number[]', retryRaw);
    } else {
      const converted: number[] = [];
      for (let i = 0; i < retryRaw.length; i += 1) {
        const item = retryRaw[i];
        const n = coerceNumber(item);
        if (n === undefined) {
          pushType(errors, `execution.retryBackoffMs[${i}]`, 'number/integer', item);
          continue;
        }
        converted.push(Math.trunc(n));
      }
      retryBackoffMs = converted;
    }
  }

  const defaultSwapRouter = defaultSwapRouterForCluster(cluster);

  const normalized: AutopilotConfig = {
    cluster,
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
      slippageBpsCap: readIntField(errors, executionIn, 'slippageBpsCap', 'execution.slippageBpsCap', DEFAULT_CONFIG.execution.slippageBpsCap),
      feeBufferLamports: readIntField(errors, executionIn, 'feeBufferLamports', 'execution.feeBufferLamports', DEFAULT_CONFIG.execution.feeBufferLamports),
      txFeeLamports: readIntField(errors, executionIn, 'txFeeLamports', 'execution.txFeeLamports', DEFAULT_CONFIG.execution.txFeeLamports),
      computeUnitLimit: readOptionalIntField(errors, executionIn, 'computeUnitLimit', 'execution.computeUnitLimit', DEFAULT_CONFIG.execution.computeUnitLimit),
      computeUnitPriceMicroLamports: readOptionalIntField(
        errors,
        executionIn,
        'computeUnitPriceMicroLamports',
        'execution.computeUnitPriceMicroLamports',
        DEFAULT_CONFIG.execution.computeUnitPriceMicroLamports,
      ),
      quoteFreshnessSec: readIntField(errors, executionIn, 'quoteFreshnessSec', 'execution.quoteFreshnessSec', DEFAULT_CONFIG.execution.quoteFreshnessSec),
      quoteFreshnessSlots: readIntField(errors, executionIn, 'quoteFreshnessSlots', 'execution.quoteFreshnessSlots', DEFAULT_CONFIG.execution.quoteFreshnessSlots),
      swapRouter:
        typeof executionIn.swapRouter === 'string'
          ? (executionIn.swapRouter as SwapRouter)
          : executionIn.swapRouter === undefined
            ? defaultSwapRouter
            : (pushType(errors, 'execution.swapRouter', "'jupiter' | 'orca' | 'noop'", executionIn.swapRouter), defaultSwapRouter),
      rebuildTickDelta: readOptionalIntField(errors, executionIn, 'rebuildTickDelta', 'execution.rebuildTickDelta', DEFAULT_CONFIG.execution.rebuildTickDelta),
      maxRetries: readIntField(errors, executionIn, 'maxRetries', 'execution.maxRetries', DEFAULT_CONFIG.execution.maxRetries),
      retryBackoffMs,
      receiptPollMaxAttempts: readIntField(
        errors,
        executionIn,
        'receiptPollMaxAttempts',
        'execution.receiptPollMaxAttempts',
        DEFAULT_CONFIG.execution.receiptPollMaxAttempts,
      ),
      receiptPollIntervalMs: readIntField(
        errors,
        executionIn,
        'receiptPollIntervalMs',
        'execution.receiptPollIntervalMs',
        DEFAULT_CONFIG.execution.receiptPollIntervalMs,
      ),
      minSolLamportsToSwap: readIntField(
        errors,
        executionIn,
        'minSolLamportsToSwap',
        'execution.minSolLamportsToSwap',
        DEFAULT_CONFIG.execution.minSolLamportsToSwap,
      ),
      minUsdcMinorToSwap: readIntField(
        errors,
        executionIn,
        'minUsdcMinorToSwap',
        'execution.minUsdcMinorToSwap',
        DEFAULT_CONFIG.execution.minUsdcMinorToSwap,
      ),
    },
    ui: {
      sampleBufferSize: readIntField(errors, uiIn, 'sampleBufferSize', 'ui.sampleBufferSize', DEFAULT_CONFIG.ui.sampleBufferSize),
    },
  };

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: normalized };
}

export function validateConfig(input: unknown): ValidateConfigResult {
  const normalized = normalizeAutopilotConfig(input);
  if (!normalized.ok) return normalized;

  const errors: ConfigError[] = [];
  const allowedClusters = new Set<Cluster>(['devnet', 'mainnet-beta', 'localnet']);
  if (!allowedClusters.has(normalized.value.cluster)) {
    pushRange(errors, 'cluster', "'devnet' | 'mainnet-beta' | 'localnet'", normalized.value.cluster);
  }

  const p = normalized.value.policy;
  if (!Number.isInteger(p.cadenceMs)) pushType(errors, 'policy.cadenceMs', 'integer', p.cadenceMs);
  else if (p.cadenceMs <= 0) pushRange(errors, 'policy.cadenceMs', '> 0', p.cadenceMs);
  if (!Number.isInteger(p.requiredConsecutive)) pushType(errors, 'policy.requiredConsecutive', 'integer', p.requiredConsecutive);
  else if (p.requiredConsecutive <= 0) pushRange(errors, 'policy.requiredConsecutive', '> 0', p.requiredConsecutive);
  if (!Number.isInteger(p.cooldownMs)) pushType(errors, 'policy.cooldownMs', 'integer', p.cooldownMs);
  else if (p.cooldownMs < 0) pushRange(errors, 'policy.cooldownMs', '>= 0', p.cooldownMs);

  const e = normalized.value.execution;
  if (!Number.isInteger(e.slippageBpsCap)) pushType(errors, 'execution.slippageBpsCap', 'integer', e.slippageBpsCap);
  else if (e.slippageBpsCap < 0 || e.slippageBpsCap > 50) pushRange(errors, 'execution.slippageBpsCap', '0..50 (bps)', e.slippageBpsCap);

  if (!Number.isInteger(e.quoteFreshnessSec)) pushType(errors, 'execution.quoteFreshnessSec', 'integer', e.quoteFreshnessSec);
  else if (e.quoteFreshnessSec <= 0) pushRange(errors, 'execution.quoteFreshnessSec', '> 0', e.quoteFreshnessSec);

  if (!Number.isInteger(e.quoteFreshnessSlots)) pushType(errors, 'execution.quoteFreshnessSlots', 'integer', e.quoteFreshnessSlots);
  else if (e.quoteFreshnessSlots < 0 || e.quoteFreshnessSlots > 1_000) pushRange(errors, 'execution.quoteFreshnessSlots', '0..1000', e.quoteFreshnessSlots);

  const allowedRouters = new Set<SwapRouter>(['jupiter', 'orca', 'noop']);
  if (!allowedRouters.has(e.swapRouter)) {
    pushRange(errors, 'execution.swapRouter', "'jupiter' | 'orca' | 'noop'", e.swapRouter);
  }

  if (e.rebuildTickDelta !== undefined) {
    if (!Number.isInteger(e.rebuildTickDelta)) pushType(errors, 'execution.rebuildTickDelta', 'integer | undefined', e.rebuildTickDelta);
    else if (e.rebuildTickDelta <= 0) pushRange(errors, 'execution.rebuildTickDelta', '> 0', e.rebuildTickDelta);
  }

  if (e.computeUnitLimit !== undefined) {
    if (!Number.isInteger(e.computeUnitLimit)) pushType(errors, 'execution.computeUnitLimit', 'integer | undefined', e.computeUnitLimit);
    else if (e.computeUnitLimit <= 0) pushRange(errors, 'execution.computeUnitLimit', '> 0', e.computeUnitLimit);
  }
  if (e.computeUnitPriceMicroLamports !== undefined) {
    if (!Number.isInteger(e.computeUnitPriceMicroLamports)) {
      pushType(errors, 'execution.computeUnitPriceMicroLamports', 'integer | undefined', e.computeUnitPriceMicroLamports);
    } else if (e.computeUnitPriceMicroLamports < 0) {
      pushRange(errors, 'execution.computeUnitPriceMicroLamports', '>= 0', e.computeUnitPriceMicroLamports);
    }
  }

  const computeLimitSet = e.computeUnitLimit !== undefined;
  const computePriceSet = e.computeUnitPriceMicroLamports !== undefined;
  if (computeLimitSet !== computePriceSet) {
    pushRange(
      errors,
      'execution.computeUnitLimit',
      'computeUnitLimit and computeUnitPriceMicroLamports must both be set or both be unset',
      { computeUnitLimit: e.computeUnitLimit, computeUnitPriceMicroLamports: e.computeUnitPriceMicroLamports },
    );
  }

  if (!Number.isInteger(e.txFeeLamports)) pushType(errors, 'execution.txFeeLamports', 'integer', e.txFeeLamports);
  else if (e.txFeeLamports < 0) pushRange(errors, 'execution.txFeeLamports', '>= 0', e.txFeeLamports);

  if (!Number.isInteger(e.feeBufferLamports)) pushType(errors, 'execution.feeBufferLamports', 'integer', e.feeBufferLamports);
  else if (e.feeBufferLamports < 0) pushRange(errors, 'execution.feeBufferLamports', '>= 0', e.feeBufferLamports);

  if (!Number.isInteger(e.maxRetries)) pushType(errors, 'execution.maxRetries', 'integer', e.maxRetries);
  else if (e.maxRetries < 1 || e.maxRetries > 10) pushRange(errors, 'execution.maxRetries', '1..10', e.maxRetries);

  if (!Array.isArray(e.retryBackoffMs)) {
    pushType(errors, 'execution.retryBackoffMs', 'number[]', e.retryBackoffMs);
  } else {
    const msg = validateBackoffSchedule(e.retryBackoffMs);
    if (msg) pushBackoff(errors, 'execution.retryBackoffMs', msg, e.retryBackoffMs);
  }

  if (!Number.isInteger(e.receiptPollMaxAttempts)) pushType(errors, 'execution.receiptPollMaxAttempts', 'integer', e.receiptPollMaxAttempts);
  else if (e.receiptPollMaxAttempts < 1 || e.receiptPollMaxAttempts > 100) {
    pushRange(errors, 'execution.receiptPollMaxAttempts', '1..100', e.receiptPollMaxAttempts);
  }

  if (!Number.isInteger(e.receiptPollIntervalMs)) pushType(errors, 'execution.receiptPollIntervalMs', 'integer', e.receiptPollIntervalMs);
  else if (e.receiptPollIntervalMs < 1 || e.receiptPollIntervalMs > 60_000) {
    pushRange(errors, 'execution.receiptPollIntervalMs', '1..60000', e.receiptPollIntervalMs);
  }

  if (!Number.isInteger(e.minSolLamportsToSwap)) pushType(errors, 'execution.minSolLamportsToSwap', 'integer', e.minSolLamportsToSwap);
  else if (e.minSolLamportsToSwap < 0) pushRange(errors, 'execution.minSolLamportsToSwap', '>= 0', e.minSolLamportsToSwap);

  if (!Number.isInteger(e.minUsdcMinorToSwap)) pushType(errors, 'execution.minUsdcMinorToSwap', 'integer', e.minUsdcMinorToSwap);
  else if (e.minUsdcMinorToSwap < 0) pushRange(errors, 'execution.minUsdcMinorToSwap', '>= 0', e.minUsdcMinorToSwap);

  const ui = normalized.value.ui;
  if (!Number.isInteger(ui.sampleBufferSize)) pushType(errors, 'ui.sampleBufferSize', 'integer', ui.sampleBufferSize);
  else if (ui.sampleBufferSize < 10 || ui.sampleBufferSize > 10_000) pushRange(errors, 'ui.sampleBufferSize', '10..10000', ui.sampleBufferSize);

  if (errors.length) return { ok: false, errors };
  return normalized;
}
