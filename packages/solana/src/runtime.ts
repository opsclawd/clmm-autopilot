import type { AutopilotConfig, ExecutionMode, RuntimeMode } from '@clmm-autopilot/core';
import { resolveReceiptRuntimeIdentity, type ReceiptRuntimeIdentity } from './receiptIdentity';
import { getSwapAdapter } from './swap/registry';
import type { CanonicalErrorCode, SolanaConfig } from './types';

type RuntimeError = Error & { code: CanonicalErrorCode; retryable: boolean; debug?: unknown };

export type RuntimeEnvironment = {
  rpcUrl?: string;
  commitment?: SolanaConfig['commitment'];
  walletConnected?: boolean;
  signingAvailable?: boolean;
  executionPausedOverride?: boolean;
  receiptIdentityEnv?: Record<string, string | undefined>;
};

export type EffectiveOperatorState = {
  executionMode: ExecutionMode;
  runtimeMode: RuntimeMode;
  executionPausedDefault: boolean;
  executionPausedOverride?: boolean;
  executionPaused: boolean;
};

export type StartupValidationInput = {
  config: AutopilotConfig;
  runtimeEnvironment?: RuntimeEnvironment;
};

export type ExecutionGateInput = StartupValidationInput & {
  requireSigning: boolean;
};

export type ExecutionGateResult = {
  operatorState: EffectiveOperatorState;
  receiptIdentity: ReceiptRuntimeIdentity | null;
};

function fail(code: CanonicalErrorCode, message: string, debug?: unknown): never {
  const err = new Error(message) as RuntimeError;
  err.code = code;
  err.retryable = false;
  if (debug !== undefined) err.debug = debug;
  throw err;
}

export function deriveEffectiveOperatorState(
  config: AutopilotConfig,
  executionPausedOverride?: boolean,
): EffectiveOperatorState {
  return {
    executionMode: config.executionMode,
    runtimeMode: config.operator.runtimeMode,
    executionPausedDefault: config.operator.executionPausedDefault,
    executionPausedOverride,
    executionPaused: executionPausedOverride ?? config.operator.executionPausedDefault,
  };
}

export function validateRuntimeEnvironment(runtimeEnvironment?: RuntimeEnvironment): void {
  const rpcUrl = runtimeEnvironment?.rpcUrl?.trim();
  if (!rpcUrl) {
    fail('RPC_URL_MISSING', 'RPC URL is required for runtime startup validation');
  }

  let parsed: URL;
  try {
    parsed = new URL(rpcUrl);
  } catch {
    fail('RPC_URL_MISSING', `Invalid RPC URL: ${rpcUrl}`);
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    fail('RPC_URL_MISSING', `Invalid RPC URL protocol: ${parsed.protocol}`, { rpcUrl });
  }
}

export function validateRuntimeStartup(params: StartupValidationInput): EffectiveOperatorState {
  validateRuntimeEnvironment(params.runtimeEnvironment);
  return deriveEffectiveOperatorState(params.config, params.runtimeEnvironment?.executionPausedOverride);
}

export function enforceExecutionGate(params: ExecutionGateInput): ExecutionGateResult {
  const operatorState = validateRuntimeStartup(params);
  const requiresLocalReceiptDb =
    operatorState.executionMode === 'mainnet-live' || operatorState.runtimeMode === 'execute';

  if (operatorState.executionPaused) {
    fail('EXECUTION_PAUSED', 'Execution is paused by operator control', {
      executionPausedDefault: operatorState.executionPausedDefault,
      executionPausedOverride: operatorState.executionPausedOverride,
    });
  }

  getSwapAdapter(params.config.execution.swapRouter, params.config.cluster);

  if (requiresLocalReceiptDb && !params.config.execution.localReceiptDbPath) {
    fail('CONFIG_INVALID', 'Execute mode requires execution.localReceiptDbPath');
  }

  if (operatorState.executionMode === 'mainnet-shadow') {
    if (params.config.execution.sendEnabled) {
      fail('EXECUTION_MODE_SEND_FORBIDDEN', 'mainnet-shadow requires sendEnabled=false', {
        executionMode: operatorState.executionMode,
        sendEnabled: params.config.execution.sendEnabled,
      });
    }
    if (params.config.execution.onChainReceiptEnabled) {
      fail('CONFIG_INVALID', 'mainnet-shadow requires execution.onChainReceiptEnabled=false', {
        executionMode: operatorState.executionMode,
        onChainReceiptEnabled: params.config.execution.onChainReceiptEnabled,
      });
    }
    return { operatorState, receiptIdentity: null };
  }

  if (operatorState.runtimeMode === 'dry-run') {
    fail('EXECUTION_MODE_BLOCKED', 'Execution is blocked while runtime mode is dry-run', {
      runtimeMode: operatorState.runtimeMode,
      executionMode: operatorState.executionMode,
    });
  }

  if (operatorState.runtimeMode === 'simulate-only') {
    if (!params.config.execution.onChainReceiptEnabled) {
      return { operatorState, receiptIdentity: null };
    }
    const receiptIdentity = resolveReceiptRuntimeIdentity(params.config, params.runtimeEnvironment?.receiptIdentityEnv);
    if (!receiptIdentity) {
      fail('RECEIPT_PROGRAM_NOT_CONFIGURED', 'Simulate-only mode requires receipt program identity when on-chain receipts are enabled');
    }
    return { operatorState, receiptIdentity };
  }

  if (operatorState.runtimeMode !== 'execute') {
    fail('RUNTIME_MODE_INVALID', `Unsupported runtime mode '${operatorState.runtimeMode}'`, {
      runtimeMode: operatorState.runtimeMode,
    });
  }

  if (params.requireSigning) {
    if (!params.runtimeEnvironment?.walletConnected || !params.runtimeEnvironment.signingAvailable) {
      fail('WALLET_PROVIDER_MISSING', 'Execute mode requires a connected wallet/provider with signing support', {
        walletConnected: params.runtimeEnvironment?.walletConnected ?? false,
        signingAvailable: params.runtimeEnvironment?.signingAvailable ?? false,
      });
    }
  }

  if (!params.config.execution.onChainReceiptEnabled) {
    return { operatorState, receiptIdentity: null };
  }

  const receiptIdentity = resolveReceiptRuntimeIdentity(params.config, params.runtimeEnvironment?.receiptIdentityEnv);
  if (!receiptIdentity) {
    fail('RECEIPT_PROGRAM_NOT_CONFIGURED', 'Execute mode requires receipt program identity configuration');
  }

  return { operatorState, receiptIdentity };
}
