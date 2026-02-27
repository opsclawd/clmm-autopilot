import type { Cluster, SwapQuote } from '@clmm-autopilot/core';
import type { PublicKey, TransactionInstruction } from '@solana/web3.js';
import type { CanonicalErrorCode } from '../../types';
import type { SolanaGetQuoteParams, SolanaSwapAdapter, SolanaSwapContext } from '../types';

type TypedError = Error & { code: CanonicalErrorCode; retryable: boolean; debug?: unknown };

function fail(code: CanonicalErrorCode, message: string, retryable: boolean, debug?: unknown): never {
  const err = new Error(message) as TypedError;
  err.code = code;
  err.retryable = retryable;
  if (debug !== undefined) err.debug = debug;
  throw err;
}

export class OrcaWhirlpoolSwapAdapter implements SolanaSwapAdapter {
  readonly name = 'orca' as const;

  supportsCluster(cluster: Cluster): boolean {
    return cluster === 'devnet' || cluster === 'mainnet-beta';
  }

  async getQuote(params: SolanaGetQuoteParams): Promise<SwapQuote> {
    if (!this.supportsCluster(params.cluster)) {
      fail('SWAP_ROUTER_UNSUPPORTED_CLUSTER', 'orca swap router supports devnet/mainnet-beta only', false, {
        cluster: params.cluster,
      });
    }

    // M14 scope: Orca quote path must use SDK quote helpers only.
    // If SDK quote wiring is missing/insufficient for the supplied context, we fail clearly.
    fail('DATA_UNAVAILABLE', 'Orca SDK quote helper wiring unavailable for current swap context', false, {
      whirlpool: params.swapContext.whirlpool.toBase58(),
      tickArrays: params.swapContext.tickArrays.map((k) => k.toBase58()),
    });
  }

  async buildSwapIxs(_quote: Readonly<SwapQuote>, _payer: PublicKey, _context: Readonly<SolanaSwapContext>): Promise<TransactionInstruction[]> {
    fail('DATA_UNAVAILABLE', 'Orca swap instruction builder is unavailable without SDK quote path', false);
  }
}
