import type { NormalizedError } from './types';

const transientHints = ['timeout', '429', 'rate limit', 'temporarily unavailable', 'econnreset'];

export function normalizeSolanaError(error: unknown): NormalizedError {
  const msg = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  const lower = msg.toLowerCase();

  if (lower.includes('blockhash')) {
    return { code: 'BLOCKHASH_EXPIRED', message: msg, retryable: true };
  }
  if (lower.includes('simulation')) {
    return { code: 'SIMULATION_FAILED', message: msg, retryable: false };
  }
  if (lower.includes('slippage')) {
    return { code: 'SLIPPAGE_EXCEEDED', message: msg, retryable: false };
  }
  if (transientHints.some((h) => lower.includes(h))) {
    return { code: 'RPC_TRANSIENT', message: msg, retryable: true };
  }

  return { code: 'RPC_PERMANENT', message: msg, retryable: false };
}
