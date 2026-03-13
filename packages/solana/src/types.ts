export type CanonicalErrorCode =
  | 'CONFIG_INVALID'
  | 'DATA_UNAVAILABLE'
  | 'UNSUPPORTED_MINT_OWNER'
  | 'RPC_TRANSIENT'
  | 'RPC_PERMANENT'
  | 'RPC_URL_MISSING'
  | 'INVALID_POSITION'
  | 'ORCA_DECODE_FAILED'
  | 'NOT_SOL_USDC'
  | 'ALREADY_EXECUTED_THIS_EPOCH'
  | 'RECEIPT_PROGRAM_NOT_CONFIGURED'
  | 'RECEIPT_IDL_MISMATCH'
  | 'RECEIPT_PROGRAM_VERIFICATION_FAILED'
  | 'QUOTE_STALE'
  | 'SIMULATION_FAILED'
  | 'SLIPPAGE_EXCEEDED'
  | 'INSUFFICIENT_FEE_BUFFER'
  | 'BLOCKHASH_EXPIRED'
  | 'MISSING_ATTESTATION_HASH'
  | 'SWAP_ROUTER_UNSUPPORTED_CLUSTER'
  | 'EXECUTION_PAUSED'
  | 'EXECUTION_MODE_BLOCKED'
  | 'WALLET_PROVIDER_MISSING'
  | 'RUNTIME_MODE_INVALID';

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
