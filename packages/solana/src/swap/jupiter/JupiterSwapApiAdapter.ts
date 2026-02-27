import type { Cluster, SwapQuote } from '@clmm-autopilot/core';
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { fetchJupiterQuote, fetchJupiterSwapIxs, type JupiterQuote } from '../../jupiter';
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

export class JupiterSwapApiAdapter implements SolanaSwapAdapter {
  readonly name = 'jupiter' as const;

  supportsCluster(cluster: Cluster): boolean {
    return cluster === 'mainnet-beta';
  }

  async getQuote(params: SolanaGetQuoteParams): Promise<SwapQuote> {
    if (!this.supportsCluster(params.cluster)) {
      fail('SWAP_ROUTER_UNSUPPORTED_CLUSTER', 'jupiter swap router supports mainnet-beta only', false, {
        cluster: params.cluster,
      });
    }
    const q = await fetchJupiterQuote({
      inputMint: new PublicKey(params.inMint),
      outputMint: new PublicKey(params.outMint),
      amount: params.swapInAmount,
      slippageBps: params.slippageBpsCap,
      nowUnixMs: () => Math.floor(Date.now() / 1000) * 1000,
    });

    return {
      router: this.name,
      inMint: params.inMint,
      outMint: params.outMint,
      swapInAmount: q.inAmount,
      swapMinOutAmount: q.outAmount,
      slippageBpsCap: params.slippageBpsCap,
      quotedAtUnixSec: Math.floor(q.quotedAtUnixMs / 1000),
      debug: { jupiterRaw: q.raw },
    };
  }

  async buildSwapIxs(quote: Readonly<SwapQuote>, payer: PublicKey, _context: Readonly<SolanaSwapContext>): Promise<TransactionInstruction[]> {
    if (quote.router !== this.name) {
      fail('DATA_UNAVAILABLE', 'quote router mismatch for jupiter adapter', false, { quoteRouter: quote.router });
    }
    const raw = quote.debug?.jupiterRaw;
    if (!raw) {
      fail('DATA_UNAVAILABLE', 'jupiter quote debug payload missing raw quote response', false);
    }
    const jupQuote: JupiterQuote = {
      inputMint: new PublicKey(quote.inMint),
      outputMint: new PublicKey(quote.outMint),
      inAmount: quote.swapInAmount,
      outAmount: quote.swapMinOutAmount,
      slippageBps: quote.slippageBpsCap,
      quotedAtUnixMs: quote.quotedAtUnixSec * 1000,
      raw,
    };
    const swap = await fetchJupiterSwapIxs({ quote: jupQuote, userPublicKey: payer, wrapAndUnwrapSol: false });
    return swap.instructions;
  }
}
