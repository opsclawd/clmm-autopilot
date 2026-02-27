import BN from 'bn.js';
import type { Cluster, SwapQuote } from '@clmm-autopilot/core';
import { Percentage, ReadOnlyWallet } from '@orca-so/common-sdk';
import {
  PDAUtil,
  UseFallbackTickArray,
  WhirlpoolContext,
  WhirlpoolIx,
  buildWhirlpoolClient,
  swapQuoteByInputToken,
} from '@orca-so/whirlpools-sdk';
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { getAta } from '../../ata';
import type { CanonicalErrorCode } from '../../types';
import type { SolanaGetQuoteParams, SolanaSwapAdapter, SolanaSwapContext } from '../types';

type TypedError = Error & { code: CanonicalErrorCode; retryable: boolean; debug?: unknown };

const ORCA_WHIRLPOOL_PROGRAM_ID = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');

type OrcaQuoteDebugPayload = {
  amount: string;
  otherAmountThreshold: string;
  sqrtPriceLimit: string;
  amountSpecifiedIsInput: boolean;
  aToB: boolean;
  tickArray0: string;
  tickArray1: string;
  tickArray2: string;
  supplementalTickArrays: string[];
};

function fail(code: CanonicalErrorCode, message: string, retryable: boolean, debug?: unknown): never {
  const err = new Error(message) as TypedError;
  err.code = code;
  err.retryable = retryable;
  if (debug !== undefined) err.debug = debug;
  throw err;
}

function asOrcaDebug(quote: Readonly<SwapQuote>): OrcaQuoteDebugPayload {
  const payload = quote.debug?.orcaQuote;
  if (!payload || typeof payload !== 'object') {
    fail('DATA_UNAVAILABLE', 'orca quote metadata is missing', false);
  }
  const q = payload as Record<string, unknown>;
  const str = (k: string): string => {
    const v = q[k];
    if (typeof v !== 'string' || v.length === 0) fail('DATA_UNAVAILABLE', `orca quote metadata missing ${k}`, false);
    return v;
  };
  const bool = (k: string): boolean => {
    const v = q[k];
    if (typeof v !== 'boolean') fail('DATA_UNAVAILABLE', `orca quote metadata missing ${k}`, false);
    return v;
  };
  const arr = q.supplementalTickArrays;
  return {
    amount: str('amount'),
    otherAmountThreshold: str('otherAmountThreshold'),
    sqrtPriceLimit: str('sqrtPriceLimit'),
    amountSpecifiedIsInput: bool('amountSpecifiedIsInput'),
    aToB: bool('aToB'),
    tickArray0: str('tickArray0'),
    tickArray1: str('tickArray1'),
    tickArray2: str('tickArray2'),
    supplementalTickArrays: Array.isArray(arr) ? arr.filter((v): v is string => typeof v === 'string') : [],
  };
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

    try {
      const wallet = new ReadOnlyWallet(params.swapContext.whirlpool);
      const ctx = WhirlpoolContext.from(params.swapContext.connection, wallet);
      const client = buildWhirlpoolClient(ctx);
      const pool = await client.getPool(params.swapContext.whirlpool);

      const quote = await swapQuoteByInputToken(
        pool,
        new PublicKey(params.inMint),
        new BN(params.swapInAmount.toString()),
        Percentage.fromFraction(params.slippageBpsCap, 10_000),
        ORCA_WHIRLPOOL_PROGRAM_ID,
        ctx.fetcher,
        undefined,
        UseFallbackTickArray.Never,
        new BN(String(params.deadlineUnixSec ?? Math.floor(Date.now() / 1000))),
      );

      return {
        router: this.name,
        inMint: params.inMint,
        outMint: params.outMint,
        swapInAmount: params.swapInAmount,
        swapMinOutAmount: BigInt(quote.otherAmountThreshold.toString()),
        slippageBpsCap: params.slippageBpsCap,
        quotedAtUnixSec: Math.floor(Date.now() / 1000),
        debug: {
          orcaQuote: {
            amount: quote.amount.toString(),
            otherAmountThreshold: quote.otherAmountThreshold.toString(),
            sqrtPriceLimit: quote.sqrtPriceLimit.toString(),
            amountSpecifiedIsInput: quote.amountSpecifiedIsInput,
            aToB: quote.aToB,
            tickArray0: quote.tickArray0.toBase58(),
            tickArray1: quote.tickArray1.toBase58(),
            tickArray2: quote.tickArray2.toBase58(),
            supplementalTickArrays: (quote.supplementalTickArrays ?? []).map((k) => k.toBase58()),
          } satisfies OrcaQuoteDebugPayload,
        },
      };
    } catch (cause) {
      fail('DATA_UNAVAILABLE', 'Orca SDK quote helper failed for swap context', false, {
        cause: cause instanceof Error ? cause.message : String(cause),
        whirlpool: params.swapContext.whirlpool.toBase58(),
      });
    }
  }

  async buildSwapIxs(
    quote: Readonly<SwapQuote>,
    payer: PublicKey,
    context: Readonly<SolanaSwapContext>,
  ): Promise<TransactionInstruction[]> {
    if (quote.router !== this.name) {
      fail('DATA_UNAVAILABLE', 'quote router mismatch for orca adapter', false, { quoteRouter: quote.router });
    }
    const q = asOrcaDebug(quote);
    const planned = context.tickArrays.map((k) => k.toBase58());
    const quoted = [q.tickArray0, q.tickArray1, q.tickArray2];
    for (let i = 0; i < Math.min(planned.length, quoted.length); i += 1) {
      if (planned[i] !== quoted[i]) {
        fail('DATA_UNAVAILABLE', 'Orca quote tick arrays do not match planned tickArrays', false, {
          planned,
          quoted,
        });
      }
    }

    const wallet = new ReadOnlyWallet(payer);
    const ctx = WhirlpoolContext.from(context.connection, wallet);

    const ix = WhirlpoolIx.swapV2Ix(ctx.program, {
      amount: new BN(q.amount),
      otherAmountThreshold: new BN(q.otherAmountThreshold),
      sqrtPriceLimit: new BN(q.sqrtPriceLimit),
      amountSpecifiedIsInput: q.amountSpecifiedIsInput,
      aToB: q.aToB,
      tickArray0: new PublicKey(q.tickArray0),
      tickArray1: new PublicKey(q.tickArray1),
      tickArray2: new PublicKey(q.tickArray2),
      supplementalTickArrays: q.supplementalTickArrays.map((k) => new PublicKey(k)),
      whirlpool: context.whirlpool,
      tokenMintA: context.tokenMintA,
      tokenMintB: context.tokenMintB,
      tokenOwnerAccountA: getAta(context.tokenMintA, payer, context.tokenProgramA),
      tokenOwnerAccountB: getAta(context.tokenMintB, payer, context.tokenProgramB),
      tokenVaultA: context.tokenVaultA,
      tokenVaultB: context.tokenVaultB,
      tokenProgramA: context.tokenProgramA,
      tokenProgramB: context.tokenProgramB,
      oracle: PDAUtil.getOracle(ORCA_WHIRLPOOL_PROGRAM_ID, context.whirlpool).publicKey,
      tokenAuthority: payer,
    });

    return [...ix.instructions, ...ix.cleanupInstructions];
  }
}
