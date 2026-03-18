import { describe, expect, it } from 'vitest';
import {
  assertExactToolVersion,
  buildSetUpgradeAuthorityArgs,
  getExpectedBuiltBinaryPaths,
  TARGET_BINARY_PATH,
  VERIFIABLE_BINARY_PATH,
// @ts-expect-error Test-only import from an untyped root script module.
} from '../../../../scripts/receipt-release-lib.mjs';

describe('receipt release lib', () => {
  it('opts out of new-authority signer enforcement for multisig/pubkey transfers', () => {
    const args = buildSetUpgradeAuthorityArgs({
      programId: 'A81Xsuwg5zrT1sgvkncemfWqQ8nymwHS3e7ExM4YnXMm',
      rpcUrl: 'https://api.mainnet-beta.solana.com',
      walletPath: '/tmp/id.json',
      expectedUpgradeAuthority: 'BPFLoaderUpgradeab1e11111111111111111111111',
    });

    expect(args).toContain('--skip-new-upgrade-authority-signer-check');
    expect(args).toEqual([
      'program',
      'set-upgrade-authority',
      'A81Xsuwg5zrT1sgvkncemfWqQ8nymwHS3e7ExM4YnXMm',
      '--new-upgrade-authority',
      'BPFLoaderUpgradeab1e11111111111111111111111',
      '--skip-new-upgrade-authority-signer-check',
      '--url',
      'https://api.mainnet-beta.solana.com',
      '--keypair',
      '/tmp/id.json',
      '--output',
      'json-compact',
    ]);
  });

  it('accepts the pinned semver token exactly', () => {
    expect(assertExactToolVersion('anchor CLI', 'anchor-cli 0.32.1', '0.32.1')).toBe('0.32.1');
    expect(assertExactToolVersion('solana CLI', 'solana-cli 2.3.0 (src:abcd1234; feat:42)', '2.3.0')).toBe('2.3.0');
  });

  it('rejects drifted tool versions that only share a prefix', () => {
    expect(() => assertExactToolVersion('anchor CLI', 'anchor-cli 0.32.10', '0.32.1')).toThrow(
      /anchor CLI version mismatch/,
    );
  });

  it('requires the canonical verifiable artifact path for verifiable builds', () => {
    expect(getExpectedBuiltBinaryPaths({ verifiable: true })).toEqual([VERIFIABLE_BINARY_PATH]);
    expect(getExpectedBuiltBinaryPaths()).toEqual([TARGET_BINARY_PATH]);
  });
});
