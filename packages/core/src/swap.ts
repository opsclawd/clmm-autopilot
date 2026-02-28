import type { Cluster, SwapRouter } from './config';

export type SwapSkipReason = 'NONE' | 'DUST' | 'ROUTER_DISABLED';

export const SWAP_ROUTER_TO_CODE: Record<SwapRouter, number> = {
  jupiter: 0,
  orca: 1,
  noop: 2,
};

export const SWAP_SKIP_REASON_TO_CODE: Record<SwapSkipReason, number> = {
  NONE: 0,
  DUST: 1,
  ROUTER_DISABLED: 2,
};

export type SwapQuote = {
  router: SwapRouter;
  inMint: string;
  outMint: string;
  swapInAmount: bigint;
  swapMinOutAmount: bigint;
  slippageBpsCap: number;
  quotedAtUnixSec: number;
  debug?: Record<string, unknown>;
};

export type GetQuoteParams = {
  cluster: Cluster;
  inMint: string;
  outMint: string;
  swapInAmount: bigint;
  slippageBpsCap: number;
  deadlineUnixSec?: number;
  quoteFreshnessSec?: number;
};

export type SwapPlan = {
  swapPlanned: boolean;
  swapSkipReason: SwapSkipReason;
  swapRouter: SwapRouter;
  quote: SwapQuote;
};

export type SwapAdapter<
  TGetQuoteParams extends GetQuoteParams = GetQuoteParams,
  TBuildSwapIxsResult = unknown,
  TPayer = unknown,
  TSwapContext = unknown,
> = {
  name: SwapRouter;
  supportsCluster(cluster: Cluster): boolean;
  getQuote(params: TGetQuoteParams): Promise<SwapQuote>;
  buildSwapIxs(quote: Readonly<SwapQuote>, payer: TPayer, context: TSwapContext): Promise<TBuildSwapIxsResult>;
};
