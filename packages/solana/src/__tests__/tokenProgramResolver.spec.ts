import { afterEach, describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
  __clearTokenProgramResolverCacheForTests,
  __tokenProgramResolverCacheSizeForTests,
  resolveTokenProgramForMint,
} from '../token/program';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../token/constants';

const pk = (seed: number) => {
  const bytes = new Uint8Array(32);
  bytes.fill(seed & 0xff);
  bytes[0] = seed & 0xff;
  bytes[1] = (seed >> 8) & 0xff;
  return new PublicKey(bytes);
};

function mockConnection(owners: Map<string, PublicKey>) {
  return {
    getAccountInfo: vi.fn(async (mint: PublicKey) => {
      const owner = owners.get(mint.toBase58());
      return owner ? ({ owner, data: Buffer.alloc(82) } as any) : null;
    }),
  };
}

describe('resolveTokenProgramForMint', () => {
  afterEach(() => {
    __clearTokenProgramResolverCacheForTests();
  });

  it('resolves token-v1 and token-2022 from mint owner', async () => {
    const mintA = pk(1);
    const mintB = pk(2);
    const connection = mockConnection(
      new Map<string, PublicKey>([
        [mintA.toBase58(), TOKEN_PROGRAM_ID],
        [mintB.toBase58(), TOKEN_2022_PROGRAM_ID],
      ]),
    );

    const infoA = await resolveTokenProgramForMint(connection as any, mintA);
    const infoB = await resolveTokenProgramForMint(connection as any, mintB);

    expect(infoA.tokenProgramId.toBase58()).toBe(TOKEN_PROGRAM_ID.toBase58());
    expect(infoA.isToken2022).toBe(false);
    expect(infoB.tokenProgramId.toBase58()).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
    expect(infoB.isToken2022).toBe(true);
  });

  it('throws non-retryable UNSUPPORTED_MINT_OWNER for unknown owners', async () => {
    const mint = pk(5);
    const connection = mockConnection(new Map<string, PublicKey>([[mint.toBase58(), pk(99)]]));

    await expect(resolveTokenProgramForMint(connection as any, mint)).rejects.toMatchObject({
      code: 'UNSUPPORTED_MINT_OWNER',
      retryable: false,
    });
  });

  it('uses LRU cache with max 512 entries', async () => {
    const owners = new Map<string, PublicKey>();
    const mints: PublicKey[] = [];
    for (let i = 1; i <= 513; i += 1) {
      const mint = pk(i);
      mints.push(mint);
      owners.set(mint.toBase58(), TOKEN_PROGRAM_ID);
    }
    const connection = mockConnection(owners);

    for (let i = 0; i < 512; i += 1) {
      await resolveTokenProgramForMint(connection as any, mints[i]);
    }
    expect(__tokenProgramResolverCacheSizeForTests()).toBe(512);

    // Refresh recency for mint[0], then insert one more to evict the old LRU (mint[1]).
    await resolveTokenProgramForMint(connection as any, mints[0]);
    await resolveTokenProgramForMint(connection as any, mints[512]);
    expect(__tokenProgramResolverCacheSizeForTests()).toBe(512);

    // mint[0] should still be cached (no new RPC call), mint[1] should have been evicted (new RPC call).
    const callsBefore = connection.getAccountInfo.mock.calls.length;
    await resolveTokenProgramForMint(connection as any, mints[0]);
    await resolveTokenProgramForMint(connection as any, mints[1]);
    const callsAfter = connection.getAccountInfo.mock.calls.length;
    expect(callsAfter - callsBefore).toBe(1);
  });
});
