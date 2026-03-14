import type { ExecutionMode } from '@clmm-autopilot/core';
import type { VersionedTransaction } from '@solana/web3.js';
import type { CanonicalErrorCode } from './types';

type TypedError = Error & { code: CanonicalErrorCode; retryable: boolean; debug?: unknown };

function fail(code: CanonicalErrorCode, message: string, debug?: unknown): never {
  const err = new Error(message) as TypedError;
  err.code = code;
  err.retryable = false;
  if (debug !== undefined) err.debug = debug;
  throw err;
}

export type ExecutionTransport = {
  kind: 'live' | 'shadow';
  submit: (tx: VersionedTransaction) => Promise<string>;
};

export class LiveSubmitter implements ExecutionTransport {
  readonly kind = 'live' as const;

  constructor(private readonly signAndSend: (tx: VersionedTransaction) => Promise<string>) {}

  async submit(tx: VersionedTransaction): Promise<string> {
    return this.signAndSend(tx);
  }
}

export class ShadowSubmitter implements ExecutionTransport {
  readonly kind = 'shadow' as const;

  constructor(private readonly executionMode: ExecutionMode) {}

  async submit(_tx: VersionedTransaction): Promise<string> {
    fail(
      'EXECUTION_MODE_SEND_FORBIDDEN',
      'Transaction submission is forbidden in shadow mode',
      { executionMode: this.executionMode },
    );
  }
}

export function createExecutionTransport(params: {
  executionMode: ExecutionMode;
  signAndSend?: (tx: VersionedTransaction) => Promise<string>;
}): ExecutionTransport {
  if (params.executionMode === 'mainnet-shadow') {
    return new ShadowSubmitter(params.executionMode);
  }
  if (!params.signAndSend) {
    fail('WALLET_PROVIDER_MISSING', 'signAndSend handler is required for non-shadow execution modes');
  }
  return new LiveSubmitter(params.signAndSend);
}
