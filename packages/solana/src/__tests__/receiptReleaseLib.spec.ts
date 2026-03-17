import { describe, expect, it } from 'vitest';
// @ts-expect-error Test-only import from an untyped root script module.
import { buildSetUpgradeAuthorityArgs } from '../../../../scripts/receipt-release-lib.mjs';

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
});
