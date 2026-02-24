export type CanonicalErrorCode =
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

export type SolanaConfig = {
  rpcUrl: string;
  cluster: 'devnet' | 'mainnet-beta' | 'localnet';
  commitment: 'processed' | 'confirmed' | 'finalized';
};

export type NormalizedError = {
  code: CanonicalErrorCode;
  message: string;
  retryable: boolean;
  debug?: unknown;
};
