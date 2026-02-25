import type { AutopilotConfig } from '@clmm-autopilot/core';
import type { PositionSnapshot } from './orcaInspector';
import { normalizeSolanaError } from './errors';

export type ReliabilityQuote = {
  quotedAtUnixMs: number;
  quotedAtSlot?: number;
  quoteTickIndex?: number;
};

export type ShouldRebuildConfig = {
  nowUnixMs: number;
  latestSlot?: number;
  quoteFreshnessMs: number;
  quoteFreshnessSlots: number;
  /** If undefined, caller should treat it as 1 * tickSpacing. */
  rebuildTickDelta?: number;
};

export function shouldRebuild(
  quote: ReliabilityQuote,
  latestSnapshot: Pick<PositionSnapshot, 'currentTickIndex' | 'lowerTickIndex' | 'upperTickIndex' | 'tickSpacing'>,
  config: ShouldRebuildConfig,
): { rebuild: boolean; reasonCode?: 'QUOTE_STALE' | 'BOUND_CROSSED' | 'TICK_MOVED' } {
  const staleByTime = config.nowUnixMs - quote.quotedAtUnixMs > config.quoteFreshnessMs;
  const staleBySlot =
    typeof quote.quotedAtSlot === 'number' && typeof config.latestSlot === 'number'
      ? config.latestSlot - quote.quotedAtSlot > config.quoteFreshnessSlots
      : false;

  if (staleByTime || staleBySlot) {
    return { rebuild: true, reasonCode: 'QUOTE_STALE' };
  }

  const crossedBound =
    latestSnapshot.currentTickIndex < latestSnapshot.lowerTickIndex ||
    latestSnapshot.currentTickIndex > latestSnapshot.upperTickIndex;
  if (crossedBound) {
    return { rebuild: true, reasonCode: 'BOUND_CROSSED' };
  }

  if (typeof quote.quoteTickIndex === 'number') {
    const moved = Math.abs(latestSnapshot.currentTickIndex - quote.quoteTickIndex);
    const delta = config.rebuildTickDelta ?? latestSnapshot.tickSpacing;
    if (moved >= delta) {
      return { rebuild: true, reasonCode: 'TICK_MOVED' };
    }
  }

  return { rebuild: false };
}

export async function withBoundedRetry<T>(
  fn: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
  cfg: Pick<AutopilotConfig['execution'], 'maxRetries' | 'retryBackoffMs'>,
): Promise<T> {
  let lastError: unknown;
  const maxAttempts = cfg.maxRetries;
  const backoffs = cfg.retryBackoffMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const normalized = normalizeSolanaError(error);
      lastError = normalized;
      if (!normalized.retryable || attempt === maxAttempts) {
        throw normalized;
      }
      const backoff = backoffs[attempt - 1] ?? backoffs[backoffs.length - 1] ?? 0;
      await sleep(backoff);
    }
  }

  throw lastError;
}

export async function refreshBlockhashIfNeeded(params: {
  getLatestBlockhash: () => Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  current: { blockhash: string; lastValidBlockHeight: number; fetchedAtUnixMs: number };
  nowUnixMs: number;
  quoteFreshnessMs: number;
  sendError?: unknown;
  rebuildMessage: () => Promise<void>;
}): Promise<{ blockhash: string; lastValidBlockHeight: number; rebuilt: boolean }> {
  const userDelayMs = params.nowUnixMs - params.current.fetchedAtUnixMs;

  const normalized = params.sendError ? normalizeSolanaError(params.sendError) : null;
  const requiresRebuild = userDelayMs > params.quoteFreshnessMs || normalized?.code === 'BLOCKHASH_EXPIRED';
  if (!requiresRebuild) {
    return {
      blockhash: params.current.blockhash,
      lastValidBlockHeight: params.current.lastValidBlockHeight,
      rebuilt: false,
    };
  }

  await params.rebuildMessage();
  const refreshed = await params.getLatestBlockhash();
  return { ...refreshed, rebuilt: true };
}
