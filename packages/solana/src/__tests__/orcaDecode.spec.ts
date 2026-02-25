import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodePositionAccount, decodeTickArrayAccount, decodeWhirlpoolAccount } from '../orca/decode';

function fixturePath(name: string): string {
  return resolve(__dirname, 'fixtures', 'orca', `${name}.base64`);
}

function loadFixture(name: string): Buffer {
  return Buffer.from(readFileSync(fixturePath(name), 'utf8').trim(), 'base64');
}

describe('orca decoders', () => {
  it('decodes captured whirlpool fixture', () => {
    const decoded = decodeWhirlpoolAccount(loadFixture('whirlpool'));
    expect(decoded.tickSpacing).toBeGreaterThan(0);
    expect(decoded.tickCurrentIndex).toBeTypeOf('number');
    expect(decoded.tokenMintA.toBase58()).toHaveLength(44);
    expect(decoded.tokenMintB.toBase58()).toHaveLength(44);
  });

  it('decodes captured position fixture', () => {
    const decoded = decodePositionAccount(loadFixture('position'));
    expect(decoded.tickLowerIndex).toBeTypeOf('number');
    expect(decoded.tickUpperIndex).toBeTypeOf('number');
    expect(BigInt(decoded.liquidity.toString())).toBeGreaterThanOrEqual(0n);
    expect(decoded.whirlpool.toBase58()).toHaveLength(44);
  });

  it('decodes captured tickarray fixture', () => {
    const decoded = decodeTickArrayAccount(loadFixture('tickarray'));
    expect(decoded.startTickIndex).toBeTypeOf('number');
    expect(Array.isArray(decoded.ticks)).toBe(true);
    expect(decoded.ticks.length).toBeGreaterThan(0);
  });

  it('normalizes truncated data to ORCA_DECODE_FAILED', () => {
    expect(() => decodeWhirlpoolAccount(Buffer.alloc(12))).toThrowError(
      expect.objectContaining({ code: 'ORCA_DECODE_FAILED' }),
    );
    expect(() => decodePositionAccount(Buffer.alloc(12))).toThrowError(
      expect.objectContaining({ code: 'ORCA_DECODE_FAILED' }),
    );
    expect(() => decodeTickArrayAccount(Buffer.alloc(12))).toThrowError(
      expect.objectContaining({ code: 'ORCA_DECODE_FAILED' }),
    );
  });
});
