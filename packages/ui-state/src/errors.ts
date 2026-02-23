export type CanonicalCode =
  | 'DATA_UNAVAILABLE'
  | 'RPC_TRANSIENT'
  | 'RPC_PERMANENT'
  | 'INVALID_POSITION'
  | 'NOT_SOL_USDC'
  | 'ALREADY_EXECUTED_THIS_EPOCH'
  | 'QUOTE_STALE'
  | 'SIMULATION_FAILED'
  | 'SLIPPAGE_EXCEEDED'
  | 'INSUFFICIENT_FEE_BUFFER'
  | 'BLOCKHASH_EXPIRED';

export type UiError = {
  code: CanonicalCode;
  title: string;
  message: string;
  debug?: string;
};

const messages: Record<CanonicalCode, Omit<UiError, 'code'>> = {
  DATA_UNAVAILABLE: { title: 'Data unavailable', message: 'Required data could not be loaded.' },
  RPC_TRANSIENT: { title: 'RPC transient', message: 'Temporary RPC issue. Retry shortly.' },
  RPC_PERMANENT: { title: 'RPC permanent', message: 'RPC error is not retryable.' },
  INVALID_POSITION: { title: 'Invalid position', message: 'Position account is invalid or missing.' },
  NOT_SOL_USDC: { title: 'Unsupported pair', message: 'Position must be SOL/USDC.' },
  ALREADY_EXECUTED_THIS_EPOCH: { title: 'Already executed', message: 'Execution already recorded for this epoch.' },
  QUOTE_STALE: { title: 'Quote stale', message: 'Quote is stale and could not be refreshed safely.' },
  SIMULATION_FAILED: { title: 'Simulation failed', message: 'Simulation failed; execution blocked.' },
  SLIPPAGE_EXCEEDED: { title: 'Slippage exceeded', message: 'Quote exceeds configured slippage cap.' },
  INSUFFICIENT_FEE_BUFFER: { title: 'Insufficient fee buffer', message: 'Insufficient lamports after fee buffer reserve.' },
  BLOCKHASH_EXPIRED: { title: 'Blockhash expired', message: 'Refresh and rebuild transaction.' },
};

export function mapErrorToUi(err: unknown): UiError {
  const code =
    typeof err === 'object' && err && 'code' in err && typeof (err as { code?: string }).code === 'string'
      ? ((err as { code: CanonicalCode }).code)
      : 'RPC_PERMANENT';
  const debug = err instanceof Error ? err.message : String(err ?? 'Unknown error');
  return { code, ...messages[code], debug };
}
