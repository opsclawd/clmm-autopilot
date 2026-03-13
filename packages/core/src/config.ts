export type Cluster = 'devnet' | 'mainnet-beta' | 'localnet';
export type SwapRouter = 'jupiter' | 'orca' | 'noop';
export type ReceiptIdlHashMode = 'full-v1';
export type RuntimeMode = 'dry-run' | 'simulate-only' | 'execute';

const DEVNET_RECEIPT_PROGRAM_ID = 'A81Xsuwg5zrT1sgvkncemfWqQ8nymwHS3e7ExM4YnXMm';
const DEVNET_RECEIPT_IDL_HASH_MODE: ReceiptIdlHashMode = 'full-v1';
const DEVNET_RECEIPT_IDL_HASH = 'a940da3a73fe037f9c596ad6f4771ab39706deef299ebe45aa0820be9b039161';
const DEVNET_RECEIPT_IDL_PATH = 'deployments/devnet/receipt.idl.json';

export type AutopilotConfig = {
  cluster: Cluster;
  // Fallback-only receipt identity fields; solana runtime resolver prefers manifest values on devnet.
  receiptProgramId?: string;
  receiptIdlHashMode?: ReceiptIdlHashMode;
  receiptIdlHash?: string;
  receiptIdlPath?: string;
  expectedUpgradeAuthority?: string;
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
  operator: {
    runtimeMode: RuntimeMode;
    executionPausedDefault: boolean;
  };
  ui: {
    sampleBufferSize: number;
  };
};

function defaultSwapRouterForCluster(cluster: Cluster): SwapRouter {
  if (cluster === 'mainnet-beta') return 'jupiter';
  if (cluster === 'localnet') return 'noop';
  return 'orca';
}

function defaultRuntimeModeForCluster(cluster: Cluster): RuntimeMode {
  if (cluster === 'devnet') return 'simulate-only';
  return 'dry-run';
}

function defaultReceiptIdentityForCluster(cluster: Cluster): Pick<
  AutopilotConfig,
  'receiptProgramId' | 'receiptIdlHashMode' | 'receiptIdlHash' | 'receiptIdlPath'
> {
  if (cluster === 'devnet') {
    return {
      receiptProgramId: DEVNET_RECEIPT_PROGRAM_ID,
      receiptIdlHashMode: DEVNET_RECEIPT_IDL_HASH_MODE,
      receiptIdlHash: DEVNET_RECEIPT_IDL_HASH,
      receiptIdlPath: DEVNET_RECEIPT_IDL_PATH,
    };
  }

  return {
    receiptProgramId: undefined,
    receiptIdlHashMode: undefined,
    receiptIdlHash: undefined,
    receiptIdlPath: undefined,
  };
}

export function getDefaultConfig(cluster: Cluster = 'devnet'): AutopilotConfig {
  const receiptDefaults = defaultReceiptIdentityForCluster(cluster);
  return {
    cluster,
    ...receiptDefaults,
    expectedUpgradeAuthority: undefined,
    policy: {
      cadenceMs: 2_000,
      requiredConsecutive: 3,
      cooldownMs: 90_000,
    },
    execution: {
      slippageBpsCap: 50,
      txFeeLamports: 20_000,
      feeBufferLamports: cluster === 'mainnet-beta' ? 15_000_000 : 10_000_000,
      computeUnitLimit: 600_000,
      computeUnitPriceMicroLamports: 10_000,
      quoteFreshnessSec: cluster === 'mainnet-beta' ? 15 : 20,
      quoteFreshnessSlots: cluster === 'mainnet-beta' ? 6 : 8,
      swapRouter: defaultSwapRouterForCluster(cluster),
      rebuildTickDelta: undefined,
      maxRetries: cluster === 'mainnet-beta' ? 2 : 3,
      retryBackoffMs: [250, 750, 2_000],
      receiptPollMaxAttempts: 6,
      receiptPollIntervalMs: 500,
      minSolLamportsToSwap: 0,
      minUsdcMinorToSwap: 0,
    },
    operator: {
      runtimeMode: defaultRuntimeModeForCluster(cluster),
      executionPausedDefault: false,
    },
    ui: {
      sampleBufferSize: 90,
    },
  };
}

export const DEFAULT_CONFIG: AutopilotConfig = getDefaultConfig();

export function deriveOperatorState(
  config: AutopilotConfig,
  executionPausedOverride?: boolean,
): {
  runtimeMode: RuntimeMode;
  executionPausedDefault: boolean;
  executionPausedOverride?: boolean;
  executionPaused: boolean;
} {
  return {
    runtimeMode: config.operator.runtimeMode,
    executionPausedDefault: config.operator.executionPausedDefault,
    executionPausedOverride,
    executionPaused: executionPausedOverride ?? config.operator.executionPausedDefault,
  };
}

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

function isLikelyBase58Pubkey(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
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

function readOptionalStringField(
  errors: ConfigError[],
  source: Record<string, unknown>,
  key: string,
  path: string,
  fallback: string | undefined,
): string | undefined {
  if (!(key in source)) return fallback;
  const raw = source[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    pushType(errors, path, 'string | undefined', raw);
    return fallback;
  }
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
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

  const defaults = getDefaultConfig(cluster);
  const policyInRaw = input.policy;
  const executionInRaw = input.execution;
  const operatorInRaw = input.operator;
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
  const operatorIn =
    operatorInRaw === undefined
      ? {}
      : isRecord(operatorInRaw)
        ? operatorInRaw
        : (pushType(errors, 'operator', 'object', operatorInRaw), {});

  const retryRaw = executionIn.retryBackoffMs;
  let retryBackoffMs = defaults.execution.retryBackoffMs;
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
    receiptProgramId: readOptionalStringField(
      errors,
      input,
      'receiptProgramId',
      'receiptProgramId',
      defaults.receiptProgramId,
    ),
    receiptIdlHashMode:
      !('receiptIdlHashMode' in input)
        ? defaults.receiptIdlHashMode
        : input.receiptIdlHashMode === undefined || input.receiptIdlHashMode === null
          ? undefined
          : typeof input.receiptIdlHashMode === 'string'
            ? (input.receiptIdlHashMode as ReceiptIdlHashMode)
            : (pushType(errors, 'receiptIdlHashMode', "'full-v1' | undefined", input.receiptIdlHashMode), defaults.receiptIdlHashMode),
    receiptIdlHash: readOptionalStringField(errors, input, 'receiptIdlHash', 'receiptIdlHash', defaults.receiptIdlHash),
    receiptIdlPath: readOptionalStringField(errors, input, 'receiptIdlPath', 'receiptIdlPath', defaults.receiptIdlPath),
    expectedUpgradeAuthority: readOptionalStringField(
      errors,
      input,
      'expectedUpgradeAuthority',
      'expectedUpgradeAuthority',
      defaults.expectedUpgradeAuthority,
    ),
    policy: {
      cadenceMs: readIntField(errors, policyIn, 'cadenceMs', 'policy.cadenceMs', defaults.policy.cadenceMs),
      requiredConsecutive: readIntField(
        errors,
        policyIn,
        'requiredConsecutive',
        'policy.requiredConsecutive',
        defaults.policy.requiredConsecutive,
      ),
      cooldownMs: readIntField(errors, policyIn, 'cooldownMs', 'policy.cooldownMs', defaults.policy.cooldownMs),
    },
    execution: {
      slippageBpsCap: readIntField(errors, executionIn, 'slippageBpsCap', 'execution.slippageBpsCap', defaults.execution.slippageBpsCap),
      feeBufferLamports: readIntField(errors, executionIn, 'feeBufferLamports', 'execution.feeBufferLamports', defaults.execution.feeBufferLamports),
      txFeeLamports: readIntField(errors, executionIn, 'txFeeLamports', 'execution.txFeeLamports', defaults.execution.txFeeLamports),
      computeUnitLimit: readOptionalIntField(errors, executionIn, 'computeUnitLimit', 'execution.computeUnitLimit', defaults.execution.computeUnitLimit),
      computeUnitPriceMicroLamports: readOptionalIntField(
        errors,
        executionIn,
        'computeUnitPriceMicroLamports',
        'execution.computeUnitPriceMicroLamports',
        defaults.execution.computeUnitPriceMicroLamports,
      ),
      quoteFreshnessSec: readIntField(errors, executionIn, 'quoteFreshnessSec', 'execution.quoteFreshnessSec', defaults.execution.quoteFreshnessSec),
      quoteFreshnessSlots: readIntField(errors, executionIn, 'quoteFreshnessSlots', 'execution.quoteFreshnessSlots', defaults.execution.quoteFreshnessSlots),
      swapRouter:
        typeof executionIn.swapRouter === 'string'
          ? (executionIn.swapRouter as SwapRouter)
          : executionIn.swapRouter === undefined
            ? defaultSwapRouter
            : (pushType(errors, 'execution.swapRouter', "'jupiter' | 'orca' | 'noop'", executionIn.swapRouter), defaultSwapRouter),
      rebuildTickDelta: readOptionalIntField(errors, executionIn, 'rebuildTickDelta', 'execution.rebuildTickDelta', defaults.execution.rebuildTickDelta),
      maxRetries: readIntField(errors, executionIn, 'maxRetries', 'execution.maxRetries', defaults.execution.maxRetries),
      retryBackoffMs,
      receiptPollMaxAttempts: readIntField(
        errors,
        executionIn,
        'receiptPollMaxAttempts',
        'execution.receiptPollMaxAttempts',
        defaults.execution.receiptPollMaxAttempts,
      ),
      receiptPollIntervalMs: readIntField(
        errors,
        executionIn,
        'receiptPollIntervalMs',
        'execution.receiptPollIntervalMs',
        defaults.execution.receiptPollIntervalMs,
      ),
      minSolLamportsToSwap: readIntField(
        errors,
        executionIn,
        'minSolLamportsToSwap',
        'execution.minSolLamportsToSwap',
        defaults.execution.minSolLamportsToSwap,
      ),
      minUsdcMinorToSwap: readIntField(
        errors,
        executionIn,
        'minUsdcMinorToSwap',
        'execution.minUsdcMinorToSwap',
        defaults.execution.minUsdcMinorToSwap,
      ),
    },
    operator: {
      runtimeMode:
        typeof operatorIn.runtimeMode === 'string'
          ? (operatorIn.runtimeMode as RuntimeMode)
          : operatorIn.runtimeMode === undefined
            ? defaults.operator.runtimeMode
            : (pushType(errors, 'operator.runtimeMode', "'dry-run' | 'simulate-only' | 'execute'", operatorIn.runtimeMode), defaults.operator.runtimeMode),
      executionPausedDefault:
        typeof operatorIn.executionPausedDefault === 'boolean'
          ? operatorIn.executionPausedDefault
          : operatorIn.executionPausedDefault === undefined
            ? defaults.operator.executionPausedDefault
            : (pushType(errors, 'operator.executionPausedDefault', 'boolean', operatorIn.executionPausedDefault), defaults.operator.executionPausedDefault),
    },
    ui: {
      sampleBufferSize: readIntField(errors, uiIn, 'sampleBufferSize', 'ui.sampleBufferSize', defaults.ui.sampleBufferSize),
    },
  };

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: normalized };
}

export function validateConfig(input: unknown): ValidateConfigResult {
  const normalized = normalizeAutopilotConfig(input);
  if (!normalized.ok) return normalized;

  const errors: ConfigError[] = [];
  const defaulted = getDefaultConfig(normalized.value.cluster);
  const allowedClusters = new Set<Cluster>(['devnet', 'mainnet-beta', 'localnet']);
  if (!allowedClusters.has(normalized.value.cluster)) {
    pushRange(errors, 'cluster', "'devnet' | 'mainnet-beta' | 'localnet'", normalized.value.cluster);
  }
  if (
    normalized.value.receiptIdlHashMode !== undefined &&
    normalized.value.receiptIdlHashMode !== 'full-v1'
  ) {
    pushRange(errors, 'receiptIdlHashMode', "'full-v1'", normalized.value.receiptIdlHashMode);
  }
  if (
    normalized.value.receiptIdlHash !== undefined &&
    !/^[a-f0-9]{64}$/i.test(normalized.value.receiptIdlHash)
  ) {
    pushRange(errors, 'receiptIdlHash', '64-char hex sha256', normalized.value.receiptIdlHash);
  }
  if (
    normalized.value.receiptProgramId !== undefined &&
    !isLikelyBase58Pubkey(normalized.value.receiptProgramId)
  ) {
    pushRange(errors, 'receiptProgramId', 'base58 pubkey string', normalized.value.receiptProgramId);
  }
  if (
    normalized.value.expectedUpgradeAuthority !== undefined &&
    !isLikelyBase58Pubkey(normalized.value.expectedUpgradeAuthority)
  ) {
    pushRange(
      errors,
      'expectedUpgradeAuthority',
      'base58 pubkey string | undefined',
      normalized.value.expectedUpgradeAuthority,
    );
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

  const operator = normalized.value.operator;
  const allowedRuntimeModes = new Set<RuntimeMode>(['dry-run', 'simulate-only', 'execute']);
  if (!allowedRuntimeModes.has(operator.runtimeMode)) {
    pushRange(errors, 'operator.runtimeMode', "'dry-run' | 'simulate-only' | 'execute'", operator.runtimeMode);
  }
  if (typeof operator.executionPausedDefault !== 'boolean') {
    pushType(errors, 'operator.executionPausedDefault', 'boolean', operator.executionPausedDefault);
  }

  if (normalized.value.cluster === 'mainnet-beta' && e.swapRouter === 'noop') {
    pushRange(errors, 'execution.swapRouter', "mainnet-beta requires 'jupiter' or 'orca'", e.swapRouter);
  }

  if (
    normalized.value.cluster === 'mainnet-beta' &&
    operator.runtimeMode === 'execute' &&
    input !== undefined &&
    isRecord(input) &&
    !('operator' in input)
  ) {
    pushRange(errors, 'operator.runtimeMode', 'mainnet-beta execute must be explicitly configured', operator.runtimeMode);
  }

  if (normalized.value.cluster === 'mainnet-beta' && operator.runtimeMode === 'execute') {
    const hasExplicitMainnetRouter = input !== undefined && isRecord(input) && isRecord(input.execution) && 'swapRouter' in input.execution;
    if (!hasExplicitMainnetRouter && e.swapRouter === defaulted.execution.swapRouter) {
      pushRange(errors, 'execution.swapRouter', 'mainnet-beta execute requires an explicit router selection', e.swapRouter);
    }
  }

  const receiptIdentityComplete =
    normalized.value.receiptProgramId !== undefined &&
    normalized.value.receiptIdlHashMode !== undefined &&
    normalized.value.receiptIdlHash !== undefined &&
    normalized.value.receiptIdlPath !== undefined;

  if (operator.runtimeMode === 'execute' && normalized.value.cluster !== 'devnet' && !receiptIdentityComplete) {
    pushRange(
      errors,
      'receiptProgramId',
      'receipt identity must be fully configured when execute mode is enabled outside devnet',
      {
        receiptProgramId: normalized.value.receiptProgramId,
        receiptIdlHashMode: normalized.value.receiptIdlHashMode,
        receiptIdlHash: normalized.value.receiptIdlHash,
        receiptIdlPath: normalized.value.receiptIdlPath,
      },
    );
  }

  const ui = normalized.value.ui;
  if (!Number.isInteger(ui.sampleBufferSize)) pushType(errors, 'ui.sampleBufferSize', 'integer', ui.sampleBufferSize);
  else if (ui.sampleBufferSize < 10 || ui.sampleBufferSize > 10_000) pushRange(errors, 'ui.sampleBufferSize', '10..10000', ui.sampleBufferSize);

  if (errors.length) return { ok: false, errors };
  return normalized;
}
