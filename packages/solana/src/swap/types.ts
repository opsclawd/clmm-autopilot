import type { Cluster, GetQuoteParams, SwapAdapter, SwapQuote } from '@clmm-autopilot/core';
import type { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';

export type SolanaSwapContext = {
  connection: Connection;
  whirlpool: PublicKey;
  tickSpacing: number;
  tickCurrentIndex: number;
  tickArrays: PublicKey[];
  tokenMintA: PublicKey;
  tokenMintB: PublicKey;
  tokenVaultA: PublicKey;
  tokenVaultB: PublicKey;
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
