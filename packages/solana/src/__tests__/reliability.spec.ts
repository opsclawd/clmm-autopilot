import { describe, expect, it, vi } from 'vitest';
import { refreshBlockhashIfNeeded, shouldRebuild, withBoundedRetry } from '../reliability';

describe('reliability', () => {
  it('stale quote triggers rebuild', () => {
    const out = shouldRebuild(
      { quotedAtUnixMs: 1_000, quotedAtSlot: 10, quoteTickIndex: 100 },
      { currentTickIndex: 100, lowerTickIndex: 90, upperTickIndex: 110, tickSpacing: 1 },
      { nowUnixMs: 25_000, latestSlot: 19, quoteFreshnessMs: 20_000, maxSlotDrift: 8 },
    );

    expect(out.rebuild).toBe(true);
    expect(out.reasonCode).toBe('QUOTE_STALE');
  });

  it('crossed bound triggers rebuild', () => {
    const out = shouldRebuild(
      { quotedAtUnixMs: 10_000, quotedAtSlot: 10, quoteTickIndex: 100 },
      { currentTickIndex: 50, lowerTickIndex: 90, upperTickIndex: 110, tickSpacing: 1 },
      { nowUnixMs: 11_000, latestSlot: 11, quoteFreshnessMs: 20_000, maxSlotDrift: 8 },
    );
    expect(out.rebuild).toBe(true);
    expect(out.reasonCode).toBe('BOUND_CROSSED');
  });

  it('tick move >= tickSpacing triggers rebuild', () => {
    const out = shouldRebuild(
      { quotedAtUnixMs: 10_000, quotedAtSlot: 10, quoteTickIndex: 100 },
      { currentTickIndex: 101, lowerTickIndex: 90, upperTickIndex: 110, tickSpacing: 1 },
      { nowUnixMs: 11_000, latestSlot: 11, quoteFreshnessMs: 20_000, maxSlotDrift: 8 },
    );
    expect(out.rebuild).toBe(true);
    expect(out.reasonCode).toBe('TICK_MOVED');
  });

  it('blockhash expiry triggers refresh + rebuild', async () => {
    const rebuildMessage = vi.fn(async () => {});
    const getLatestBlockhash = vi.fn(async () => ({ blockhash: 'new', lastValidBlockHeight: 2 }));

    const out = await refreshBlockhashIfNeeded({
      getLatestBlockhash,
      current: { blockhash: 'old', lastValidBlockHeight: 1, fetchedAtUnixMs: 1000 },
      nowUnixMs: 1001,
      sendError: new Error('blockhash not found'),
      rebuildMessage,
    });

    expect(out.rebuilt).toBe(true);
    expect(out.blockhash).toBe('new');
    expect(rebuildMessage).toHaveBeenCalledOnce();
  });

  it('transient rpc retries max 3 then fails normalized', async () => {
    const fn = vi.fn(async () => {
      throw new Error('timeout from rpc');
    });
    const sleep = vi.fn(async () => {});

    await expect(withBoundedRetry(fn, sleep, 3)).rejects.toMatchObject({ code: 'RPC_TRANSIENT' });
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 250);
    expect(sleep).toHaveBeenNthCalledWith(2, 750);
  });
});
