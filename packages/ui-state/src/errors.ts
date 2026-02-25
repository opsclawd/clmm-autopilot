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
  | 'BLOCKHASH_EXPIRED'
  | 'MISSING_ATTESTATION_HASH'
  | 'ORCA_DECODE_FAILED'
  | 'CONFIG_INVALID';

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
  MISSING_ATTESTATION_HASH: { title: 'Missing attestation hash', message: 'Execution attestation hash is missing or invalid.' },
  ORCA_DECODE_FAILED: { title: 'Orca decode failed', message: 'Unable to decode required Orca account data.' },
  CONFIG_INVALID: { title: 'Invalid configuration', message: 'Autopilot configuration is invalid. Fix config values before execution.' },
};

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function mapErrorToUi(err: unknown): UiError {
  const code =
    typeof err === 'object' && err && 'code' in err && typeof (err as { code?: string }).code === 'string'
      ? ((err as { code: CanonicalCode }).code)
      : 'RPC_PERMANENT';

  const debugRaw =
    typeof err === 'object' && err && 'debug' in err
      ? (err as { debug?: unknown }).debug
      : err instanceof Error
        ? err.message
        : String(err ?? 'Unknown error');

  // Provide actionable detail for fee-buffer failures while preserving canonical taxonomy.
  if (code === 'INSUFFICIENT_FEE_BUFFER' && typeof debugRaw === 'object' && debugRaw) {
    const d = debugRaw as {
      availableLamports?: number;
      deficitLamports?: number;
      requirements?: {
        rentLamports?: number;
        ataCount?: number;
        txFeeLamports?: number;
        priorityFeeLamports?: number;
        bufferLamports?: number;
        totalRequiredLamports?: number;
      };
    };

    const req = d.requirements ?? {};
    const parts = [
      typeof d.availableLamports === 'number' ? `available=${d.availableLamports}` : undefined,
      typeof req.totalRequiredLamports === 'number' ? `required≈${req.totalRequiredLamports}` : undefined,
      typeof d.deficitLamports === 'number' ? `deficit=${d.deficitLamports}` : undefined,
      typeof req.ataCount === 'number' ? `missingATAs=${req.ataCount}` : undefined,
      typeof req.rentLamports === 'number' ? `rent≈${req.rentLamports}` : undefined,
      typeof req.txFeeLamports === 'number' ? `txFee≈${req.txFeeLamports}` : undefined,
      typeof req.priorityFeeLamports === 'number' ? `priority≈${req.priorityFeeLamports}` : undefined,
      typeof req.bufferLamports === 'number' ? `buffer=${req.bufferLamports}` : undefined,
    ].filter(Boolean);

    return {
      code,
      ...messages[code],
      message: parts.length ? `Not enough SOL for fees/buffer (${parts.join(', ')}).` : messages[code].message,
      debug: safeJson(debugRaw),
    };
  }

  return { code, ...messages[code], debug: typeof debugRaw === 'string' ? debugRaw : safeJson(debugRaw) };
}
