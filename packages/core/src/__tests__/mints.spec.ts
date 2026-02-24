import { describe, expect, it } from 'vitest';
import { assertSolUsdcPair, getMintRegistry, isSolUsdcPair } from '../mints';

const SOL = 'So11111111111111111111111111111111111111112';
const SOL_NATIVE = 'SOL_NATIVE';
const USDC_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const USDT = 'Es9vMFrzaCERmJfrF4H2RFxYDs2fzGEGZm4G6dkhQ5tq';
const JITOSOL = 'jitoSo1uCvR4TBGjW8R5m6h3vN8nQ7yS9M2K1jitoSo';

describe('mint registry + SOL/USDC pair guardrails', () => {
  it('isSolUsdcPair passes for SOL/USDC in both orderings', () => {
    expect(isSolUsdcPair(SOL, USDC_DEVNET, 'devnet')).toBe(true);
    expect(isSolUsdcPair(USDC_DEVNET, SOL, 'devnet')).toBe(true);
    expect(isSolUsdcPair(SOL_NATIVE, USDC_DEVNET, 'devnet')).toBe(true);
    expect(isSolUsdcPair(USDC_DEVNET, SOL_NATIVE, 'devnet')).toBe(true);
  });

  it('isSolUsdcPair rejects non-SOL/USDC combinations', () => {
    expect(isSolUsdcPair(SOL, USDT, 'devnet')).toBe(false);
    expect(isSolUsdcPair(SOL, JITOSOL, 'devnet')).toBe(false);
    expect(isSolUsdcPair(USDC_DEVNET, USDT, 'devnet')).toBe(false);
    expect(isSolUsdcPair('11111111111111111111111111111111', '22222222222222222222222222222222', 'devnet')).toBe(false);
  });

  it('assertSolUsdcPair throws canonical NOT_SOL_USDC', () => {
    expect(() => assertSolUsdcPair(SOL, USDT, 'devnet')).toThrowError(
      expect.objectContaining({ code: 'NOT_SOL_USDC', retryable: false }),
    );
  });

  it('returns native SOL marker + cluster-scoped USDC in registry', () => {
    expect(getMintRegistry('devnet').sol).toBe(SOL_NATIVE);
    expect(getMintRegistry('devnet').usdc).toBe(USDC_DEVNET);
    expect(getMintRegistry('mainnet-beta').usdc).not.toBe(USDC_DEVNET);
  });
});
