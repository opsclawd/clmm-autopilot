import type { Cluster, SwapQuote } from '@clmm-autopilot/core';
import type { PublicKey } from '@solana/web3.js';
import type { CanonicalErrorCode } from '../../types';
import type { SolanaGetQuoteParams, SolanaSwapAdapter, SolanaSwapBuildResult, SolanaSwapContext } from '../types';

type TypedError = Error & { code: CanonicalErrorCode; retryable: boolean; debug?: unknown };

function fail(code: CanonicalErrorCode, message: string, retryable: boolean, debug?: unknown): never {
  const err = new Error(message) as TypedError;
  err.code = code;
  err.retryable = retryable;
  if (debug !== undefined) err.debug = debug;
  throw err;
}

export class NoopSwapAdapter implements SolanaSwapAdapter {
  readonly name = 'noop' as const;

  supportsCluster(_cluster: Cluster): boolean {
    return true;
  }

  async getQuote(params: SolanaGetQuoteParams): Promise<SwapQuote> {
    return {
      router: this.name,
      inMint: params.inMint,
      outMint: params.outMint,
      swapInAmount: params.swapInAmount,
      swapMinOutAmount: BigInt(0),
      slippageBpsCap: params.slippageBpsCap,
      quotedAtUnixSec: Math.floor(Date.now() / 1000),
    };
  }

  async buildSwapIxs(quote: Readonly<SwapQuote>, _payer: PublicKey, _context: Readonly<SolanaSwapContext>): Promise<SolanaSwapBuildResult> {
    if (quote.router !== this.name) {
      fail('DATA_UNAVAILABLE', 'quote router mismatch for noop adapter', false, { quoteRouter: quote.router });
    }
    return { instructions: [], lookupTableAddresses: [] };
  }
}
