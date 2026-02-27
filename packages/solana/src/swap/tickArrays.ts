import BN from 'bn.js';
import { PDAUtil, PriceMath } from '@orca-so/whirlpools-sdk';
import { PublicKey } from '@solana/web3.js';
import type { CanonicalErrorCode } from '../types';

const ORCA_WHIRLPOOL_PROGRAM_ID = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');

type TypedError = Error & { code: CanonicalErrorCode; retryable: boolean; debug?: unknown };

function fail(code: CanonicalErrorCode, message: string, retryable: boolean, debug?: unknown): never {
  const err = new Error(message) as TypedError;
  err.code = code;
  err.retryable = retryable;
  if (debug !== undefined) err.debug = debug;
  throw err;
}

export type DeriveSwapTickArraysParams = {
  whirlpool: PublicKey;
  tickSpacing: number;
  tickCurrentIndex: number;
  aToB: boolean;
  sqrtPriceLimitX64?: bigint;
  maxTickArrays?: 1 | 2 | 3;
};

export function deriveSwapTickArrays(params: DeriveSwapTickArraysParams): PublicKey[] {
  const maxTickArrays = params.maxTickArrays ?? 3;
  const offsets = [0, 1, 2].slice(0, maxTickArrays).map((n) => (params.aToB ? -n : n));

  const out: PublicKey[] = offsets.map((offset) =>
    PDAUtil.getTickArrayFromTickIndex(
      params.tickCurrentIndex,
      params.tickSpacing,
      params.whirlpool,
      ORCA_WHIRLPOOL_PROGRAM_ID,
      offset,
    ).publicKey,
  );

  if (params.sqrtPriceLimitX64 !== undefined) {
    const limitTick = PriceMath.sqrtPriceX64ToTickIndex(new BN(params.sqrtPriceLimitX64.toString()));
    const movingTowardsLimit = params.aToB ? limitTick <= params.tickCurrentIndex : limitTick >= params.tickCurrentIndex;
    if (!movingTowardsLimit) {
      fail('DATA_UNAVAILABLE', 'Provided sqrtPriceLimitX64 is not in swap direction', false, {
        tickCurrentIndex: params.tickCurrentIndex,
        limitTick,
        aToB: params.aToB,
      });
    }
    // Conservative planner guardrail: if limit is farther than max traversal windows, fail early.
    const ticksPerArray = params.tickSpacing * 88;
    const coverage = ticksPerArray * maxTickArrays;
    const distance = Math.abs(limitTick - params.tickCurrentIndex);
    if (distance > coverage) {
      fail('DATA_UNAVAILABLE', 'Swap traversal exceeds maxTickArrays coverage', false, {
        distanceTicks: distance,
        coverageTicks: coverage,
        maxTickArrays,
      });
    }
  }

  return out;
}
