export type CanonicalErrorCode =
  | 'DATA_UNAVAILABLE'
  | 'RPC_TRANSIENT'
  | 'RPC_PERMANENT'
  | 'INVALID_POSITION'
  | 'ORCA_DECODE_FAILED'
  | 'NOT_SOL_USDC'
  | 'ALREADY_EXECUTED_THIS_EPOCH'
  | 'QUOTE_STALE'
  | 'SIMULATION_FAILED'
  | 'SLIPPAGE_EXCEEDED'
  | 'INSUFFICIENT_FEE_BUFFER'
  | 'BLOCKHASH_EXPIRED'
  | 'MISSING_ATTESTATION_HASH'
  | 'ORCA_DECODE_FAILED';

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
