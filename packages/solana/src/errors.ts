import type { CanonicalErrorCode, NormalizedError } from './types';

const transientHints = ['timeout', '429', 'rate limit', 'temporarily unavailable', 'econnreset'];
const CANONICAL_CODES: CanonicalErrorCode[] = [
  'DATA_UNAVAILABLE',
  'RPC_TRANSIENT',
  'RPC_PERMANENT',
  'INVALID_POSITION',
  'NOT_SOL_USDC',
  'ALREADY_EXECUTED_THIS_EPOCH',
  'QUOTE_STALE',
  'SIMULATION_FAILED',
  'SLIPPAGE_EXCEEDED',
  'INSUFFICIENT_FEE_BUFFER',
  'BLOCKHASH_EXPIRED',
  'MISSING_ATTESTATION_HASH',
  'SWAP_ROUTER_UNSUPPORTED_CLUSTER',
  'ORCA_DECODE_FAILED',
];

function isCanonicalCode(value: unknown): value is CanonicalErrorCode {
  return typeof value === 'string' && CANONICAL_CODES.includes(value as CanonicalErrorCode);
}

export function normalizeSolanaError(error: unknown): NormalizedError {
  if (typeof error === 'object' && error) {
    const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown };
    if (isCanonicalCode(candidate.code)) {
      return {
        code: candidate.code,
        message: typeof candidate.message === 'string' ? candidate.message : String(candidate.code),
        retryable: typeof candidate.retryable === 'boolean' ? candidate.retryable : false,
        debug: 'debug' in candidate ? (candidate as { debug?: unknown }).debug : undefined,
      };
    }
  }

  const msg = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  const lower = msg.toLowerCase();

  if (
    lower.includes('blockhash not found') ||
    lower.includes('blockhash expired') ||
    lower.includes('transaction was not confirmed')
  ) {
    return { code: 'BLOCKHASH_EXPIRED', message: msg, retryable: true };
  }

  if (lower.includes('simulation failed') || lower.includes('transaction simulation failed')) {
    return { code: 'SIMULATION_FAILED', message: msg, retryable: false };
  }

  if (lower.includes('slippage tolerance exceeded') || lower.includes('slippage exceeded')) {
    return { code: 'SLIPPAGE_EXCEEDED', message: msg, retryable: false };
  }

  if (transientHints.some((h) => lower.includes(h))) {
    return { code: 'RPC_TRANSIENT', message: msg, retryable: true };
  }

  return { code: 'RPC_PERMANENT', message: msg, retryable: false };
}
