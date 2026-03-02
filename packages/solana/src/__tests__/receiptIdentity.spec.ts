import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type AutopilotConfig } from '@clmm-autopilot/core';
import {
  computeReceiptIdlHashFullV1,
  getDefaultDevnetReceiptManifest,
  resolveReceiptRuntimeIdentity,
} from '../receiptIdentity';
import defaultReceiptIdl from '../../../../deployments/devnet/receipt.idl.json';

function mkConfig(overrides?: Partial<AutopilotConfig>): AutopilotConfig {
  return {
    ...DEFAULT_CONFIG,
    cluster: 'devnet',
    ...overrides,
  };
}

describe('receiptIdentity resolver', () => {
  it('prefers manifest identity on devnet when config identity is valid', () => {
    const manifest = getDefaultDevnetReceiptManifest();
    const actualHash = computeReceiptIdlHashFullV1(defaultReceiptIdl);
    const resolved = resolveReceiptRuntimeIdentity(mkConfig({
      receiptProgramId: manifest.programId,
      receiptIdlHashMode: 'full-v1',
      receiptIdlHash: actualHash,
      receiptIdlPath: manifest.idlPath,
    }));

    expect(resolved?.source).toBe('manifest');
    expect(resolved?.programId.toBase58()).toBe(manifest.programId);
  });

  it('uses manifest identity on devnet when config fallback identity is missing', () => {
    const manifest = getDefaultDevnetReceiptManifest();
    const resolved = resolveReceiptRuntimeIdentity(
      mkConfig({
        receiptProgramId: undefined,
        receiptIdlHashMode: undefined,
        receiptIdlHash: undefined,
        receiptIdlPath: undefined,
      }),
    );

    expect(resolved?.source).toBe('manifest');
    expect(resolved?.programId.toBase58()).toBe(manifest.programId);
  });

  it('can force fallback config source for local overrides', () => {
    const actualHash = computeReceiptIdlHashFullV1(defaultReceiptIdl);
    const resolved = resolveReceiptRuntimeIdentity(
      mkConfig({
        receiptProgramId: 'A81Xsuwg5zrT1sgvkncemfWqQ8nymwHS3e7ExM4YnXMm',
        receiptIdlHashMode: 'full-v1',
        receiptIdlHash: actualHash,
        receiptIdlPath: 'deployments/devnet/receipt.idl.json',
      }),
      { RECEIPT_IDENTITY_SOURCE: 'config' },
    );

    expect(resolved?.source).toBe('config');
    expect(resolved?.idlHash).toBe(actualHash);
  });

  it('throws RECEIPT_PROGRAM_NOT_CONFIGURED when forced config fallback is incomplete', () => {
    expect(() =>
      resolveReceiptRuntimeIdentity(
        mkConfig({
          receiptProgramId: undefined,
          receiptIdlHashMode: undefined,
          receiptIdlHash: undefined,
          receiptIdlPath: undefined,
        }),
        { RECEIPT_IDENTITY_SOURCE: 'config' },
      ),
    ).toThrowError(/Config fallback receipt identity is not fully configured/);
  });

  it('throws RECEIPT_IDL_MISMATCH when forced config hash does not match runtime IDL', () => {
    expect(() =>
      resolveReceiptRuntimeIdentity(
        mkConfig({
          receiptProgramId: 'A81Xsuwg5zrT1sgvkncemfWqQ8nymwHS3e7ExM4YnXMm',
          receiptIdlHashMode: 'full-v1',
          receiptIdlHash: '0'.repeat(64),
          receiptIdlPath: 'deployments/devnet/receipt.idl.json',
        }),
        { RECEIPT_IDENTITY_SOURCE: 'config' },
      ),
    ).toThrowError(/idlHash does not match runtime IDL hash/);
  });

  it('throws RECEIPT_IDL_MISMATCH when forced config idlPath is missing/unloadable', () => {
    const actualHash = computeReceiptIdlHashFullV1(defaultReceiptIdl);
    expect(() =>
      resolveReceiptRuntimeIdentity(
        mkConfig({
          receiptProgramId: 'A81Xsuwg5zrT1sgvkncemfWqQ8nymwHS3e7ExM4YnXMm',
          receiptIdlHashMode: 'full-v1',
          receiptIdlHash: actualHash,
          receiptIdlPath: 'deployments/devnet/does-not-exist.idl.json',
        }),
        { RECEIPT_IDENTITY_SOURCE: 'config' },
      ),
    ).toThrowError(/idlPath could not be loaded/);
  });

  it('returns null for non-devnet clusters', () => {
    const res = resolveReceiptRuntimeIdentity({ ...DEFAULT_CONFIG, cluster: 'localnet' });
    expect(res).toBeNull();
  });
});
