import type { NormalizedError, ShadowSimulationClass } from './types';

export function classifyShadowSimulationResult(input: {
  status: 'SIMULATED' | 'ERROR' | 'HOLD' | 'EXECUTED';
  error?: NormalizedError | null;
}): ShadowSimulationClass {
  if (input.status === 'SIMULATED' || input.status === 'EXECUTED') return 'SIM_OK';
  if (!input.error) return 'SIM_UNKNOWN';

  const code = input.error.code;
  if (code === 'RPC_TRANSIENT' || code === 'RPC_PERMANENT' || code === 'RPC_URL_MISSING') {
    return 'SIM_RPC_ERROR';
  }
  if (code === 'DATA_UNAVAILABLE' || code === 'INVALID_POSITION') {
    return 'SIM_ACCOUNT_MISSING';
  }
  if (code === 'QUOTE_STALE') {
    return 'SIM_QUOTE_STALE';
  }
  if (code === 'SLIPPAGE_EXCEEDED') {
    return 'SIM_SLIPPAGE_EXCEEDED';
  }
  if (
    code === 'UNSUPPORTED_MINT_OWNER' ||
    code === 'ORCA_DECODE_FAILED' ||
    (typeof input.error.debug === 'object' &&
      input.error.debug !== null &&
      JSON.stringify(input.error.debug).toLowerCase().includes('token-2022'))
  ) {
    return 'SIM_TOKEN2022_ACCOUNT_MISMATCH';
  }
  if (
    code === 'RECEIPT_CONFIG_INCOMPLETE_FOR_SHADOW' ||
    code === 'RECEIPT_PROGRAM_NOT_CONFIGURED' ||
    code === 'RECEIPT_IDL_MISMATCH' ||
    code === 'RECEIPT_PROGRAM_VERIFICATION_FAILED'
  ) {
    return 'SIM_RECEIPT_CONFIG_ERROR';
  }
  return 'SIM_UNKNOWN';
}
