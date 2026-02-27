import type { Cluster, GetQuoteParams, SwapAdapter, SwapQuote } from '@clmm-autopilot/core';
import type { PublicKey, TransactionInstruction } from '@solana/web3.js';

export type SolanaSwapContext = {
  whirlpool: PublicKey;
  tickSpacing: number;
  tickCurrentIndex: number;
  tickArrays: PublicKey[];
  tokenMintA: PublicKey;
  tokenMintB: PublicKey;
  tokenProgramA: PublicKey;
  tokenProgramB: PublicKey;
  sqrtPriceLimitX64?: bigint;
  aToB: boolean;
};

export type SolanaGetQuoteParams = GetQuoteParams & {
  cluster: Cluster;
  swapContext: SolanaSwapContext;
};

export type SolanaSwapAdapter = SwapAdapter & {
  getQuote(params: SolanaGetQuoteParams): Promise<SwapQuote>;
  buildSwapIxs(quote: Readonly<SwapQuote>, payer: PublicKey, context: Readonly<SolanaSwapContext>): Promise<TransactionInstruction[]>;
};
