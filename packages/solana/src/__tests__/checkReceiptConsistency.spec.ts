import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { verifyReceiptProgramOnChainMock } = vi.hoisted(() => ({
  verifyReceiptProgramOnChainMock: vi.fn(),
}));

vi.mock('../receiptProgramVerification', () => ({
  verifyReceiptProgramOnChain: verifyReceiptProgramOnChainMock,
}));

import { checkReceiptConsistency } from '../checkReceiptConsistency';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, '../../../..');
const MAINNET_MANIFEST_FIXTURE = resolve(REPO_ROOT, 'packages/solana/src/__tests__/fixtures/mainnet-receipt-manifest.json');
const TMP_ROOT = resolve('/tmp', 'clmm-autopilot-check-receipt-consistency');

afterEach(() => {
  verifyReceiptProgramOnChainMock.mockReset();
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe('checkReceiptConsistency', () => {
  it('accepts the mainnet release fixture when local artifacts and authority metadata are consistent', async () => {
    verifyReceiptProgramOnChainMock.mockResolvedValue({
      programId: 'A81Xsuwg5zrT1sgvkncemfWqQ8nymwHS3e7ExM4YnXMm',
      owner: 'BPFLoaderUpgradeab1e11111111111111111111111',
      upgradeAuthority: 'A81Xsuwg5zrT1sgvkncemfWqQ8nymwHS3e7ExM4YnXMm',
    });

    const result = await checkReceiptConsistency({
      cluster: 'mainnet',
      manifestPath: MAINNET_MANIFEST_FIXTURE,
      rpcUrl: 'https://api.mainnet-beta.solana.com',
    });

    expect(result.programId).toBe('A81Xsuwg5zrT1sgvkncemfWqQ8nymwHS3e7ExM4YnXMm');
    expect(result.idlPath).toBe('deployments/mainnet/receipt.idl.json');
    expect(result.programBinarySha256).toBe('4e31f65972a37276da4bc3298bb6c7c0f989b55903526e4b2dba811f57ff903e');
    expect(verifyReceiptProgramOnChainMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a mainnet manifest when the retained binary hash does not match the recorded sha256', async () => {
    verifyReceiptProgramOnChainMock.mockResolvedValue({
      programId: 'A81Xsuwg5zrT1sgvkncemfWqQ8nymwHS3e7ExM4YnXMm',
      owner: 'BPFLoaderUpgradeab1e11111111111111111111111',
      upgradeAuthority: 'A81Xsuwg5zrT1sgvkncemfWqQ8nymwHS3e7ExM4YnXMm',
    });

    const tempDir = resolve(TMP_ROOT, 'bad-hash');
    mkdirSync(tempDir, { recursive: true });
    const manifestPath = resolve(tempDir, 'receipt.json');
    const manifest = JSON.parse(readFileSync(MAINNET_MANIFEST_FIXTURE, 'utf8'));
    manifest.programBinarySha256 = '0'.repeat(64);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    await expect(
      checkReceiptConsistency({
        cluster: 'mainnet',
        manifestPath,
        rpcUrl: 'https://api.mainnet-beta.solana.com',
      }),
    ).rejects.toThrow(/programBinarySha256 does not match binary artifact/);
  });
});
