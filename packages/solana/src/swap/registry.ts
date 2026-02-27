import type { Cluster, SwapRouter } from '@clmm-autopilot/core';
import type { CanonicalErrorCode } from '../types';
import { JupiterSwapApiAdapter } from './jupiter/JupiterSwapApiAdapter';
import { NoopSwapAdapter } from './noop/NoopSwapAdapter';
import { OrcaWhirlpoolSwapAdapter } from './orca/OrcaWhirlpoolSwapAdapter';
import type { SolanaSwapAdapter } from './types';

type TypedError = Error & { code: CanonicalErrorCode; retryable: boolean; debug?: unknown };

function fail(code: CanonicalErrorCode, message: string, retryable: boolean, debug?: unknown): never {
  const err = new Error(message) as TypedError;
  err.code = code;
  err.retryable = retryable;
  if (debug !== undefined) err.debug = debug;
  throw err;
}

const adapters: Record<SwapRouter, SolanaSwapAdapter> = {
  jupiter: new JupiterSwapApiAdapter(),
  orca: new OrcaWhirlpoolSwapAdapter(),
  noop: new NoopSwapAdapter(),
};

export function getSwapAdapter(router: SwapRouter, cluster: Cluster): SolanaSwapAdapter {
  const adapter = adapters[router];
  if (!adapter.supportsCluster(cluster)) {
    const localnetHint =
      cluster === 'localnet' && router === 'orca'
        ? 'orca not supported on localnet unless whirlpool program and pool are provisioned'
        : undefined;
    fail('SWAP_ROUTER_UNSUPPORTED_CLUSTER', `swap router '${router}' does not support cluster '${cluster}'`, false, {
      router,
      cluster,
      localnetHint,
    });
  }
  return adapter;
}
