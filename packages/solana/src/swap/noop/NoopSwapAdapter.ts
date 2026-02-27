import type { Cluster, SwapQuote } from '@clmm-autopilot/core';
import type { PublicKey, TransactionInstruction } from '@solana/web3.js';
import type { SolanaGetQuoteParams, SolanaSwapAdapter, SolanaSwapContext } from '../types';

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

  async buildSwapIxs(_quote: Readonly<SwapQuote>, _payer: PublicKey, _context: Readonly<SolanaSwapContext>): Promise<TransactionInstruction[]> {
    return [];
  }
}
