import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteLocalReceiptLedger } from '../localReceiptLedger';
import { ShadowArtifactStore } from '../shadow/artifactStore';

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'm21-local-ledger-'));
  cleanupDirs.push(dir);
  return join(dir, 'receipts.db');
}

function baseClaim(overrides: Partial<Parameters<ReturnType<typeof createSqliteLocalReceiptLedger>['claim']>[0]> = {}) {
  return {
    cluster: 'devnet',
    executionMode: 'devnet-live' as const,
    authority: 'authority-1',
    positionAddress: 'position-1',
    positionMint: 'mint-1',
    whirlpoolAddress: 'whirlpool-1',
    epoch: 42,
    direction: 'DOWN' as const,
    attestationHash: new Uint8Array(32).fill(1),
    attestationPayloadBytes: new Uint8Array([1, 2, 3]),
    claimToken: 'claim-1',
    nowUnixMs: 1_000,
    claimTtlMs: 500,
    onChainReceiptEnabled: false,
    ...overrides,
  };
}

describe('SqliteLocalReceiptLedger', () => {
  it('creates schema idempotently alongside shadow tables', async () => {
    const dbPath = await makeDbPath();
    const shadow = new ShadowArtifactStore(dbPath);
    shadow.close();

    const first = createSqliteLocalReceiptLedger(dbPath);
    first.close();

    const second = createSqliteLocalReceiptLedger(dbPath);
    expect(second.list()).toEqual([]);
    second.close();
  });

  it('blocks duplicate claim when row is confirmed', async () => {
    const dbPath = await makeDbPath();
    const ledger = createSqliteLocalReceiptLedger(dbPath);

    const claimed = ledger.claim(baseClaim());
    expect(claimed.kind).toBe('claimed');
    ledger.confirm({
      cluster: 'devnet',
      authority: 'authority-1',
      positionMint: 'mint-1',
      epoch: 42,
      claimToken: 'claim-1',
      nowUnixMs: 2_000,
      txSignature: 'sig-1',
      onChainReceiptVerified: false,
    });

    const duplicate = ledger.claim(baseClaim({ claimToken: 'claim-2', nowUnixMs: 3_000 }));
    expect(duplicate.kind).toBe('blocked');
    if (duplicate.kind === 'blocked') {
      expect(duplicate.status).toBe('confirmed');
    }
    ledger.close();
  });

  it('blocks duplicate claim when row is a fresh pending claim', async () => {
    const dbPath = await makeDbPath();
    const ledger = createSqliteLocalReceiptLedger(dbPath);

    const claimed = ledger.claim(baseClaim());
    expect(claimed.kind).toBe('claimed');

    const duplicate = ledger.claim(baseClaim({ claimToken: 'claim-2', nowUnixMs: 1_200 }));
    expect(duplicate.kind).toBe('blocked');
    if (duplicate.kind === 'blocked') {
      expect(duplicate.status).toBe('pending');
    }
    ledger.close();
  });

  it('allows deterministic recovery of stale pending claims', async () => {
    const dbPath = await makeDbPath();
    const ledger = createSqliteLocalReceiptLedger(dbPath);

    expect(ledger.claim(baseClaim()).kind).toBe('claimed');

    const recovered = ledger.claim(baseClaim({ claimToken: 'claim-2', nowUnixMs: 2_000 }));
    expect(recovered.kind).toBe('claimed');
    if (recovered.kind === 'claimed') {
      expect(recovered.row.claimToken).toBe('claim-2');
      expect(recovered.row.status).toBe('pending');
    }
    ledger.close();
  });

  it('marks failure metadata and allows a retryable re-claim', async () => {
    const dbPath = await makeDbPath();
    const ledger = createSqliteLocalReceiptLedger(dbPath);

    expect(ledger.claim(baseClaim()).kind).toBe('claimed');
    const failed = ledger.fail({
      cluster: 'devnet',
      authority: 'authority-1',
      positionMint: 'mint-1',
      epoch: 42,
      claimToken: 'claim-1',
      nowUnixMs: 1_500,
      errorCode: 'SIMULATION_FAILED',
      errorMessage: 'sim failed',
      errorDebug: { logs: ['oops'] },
    });
    expect(failed.status).toBe('failed');
    expect(failed.lastErrorCode).toBe('SIMULATION_FAILED');

    const retried = ledger.claim(baseClaim({ claimToken: 'claim-2', nowUnixMs: 2_500 }));
    expect(retried.kind).toBe('claimed');
    ledger.close();
  });

  it('guards confirm updates by claim token', async () => {
    const dbPath = await makeDbPath();
    const ledger = createSqliteLocalReceiptLedger(dbPath);

    expect(ledger.claim(baseClaim()).kind).toBe('claimed');
    expect(ledger.claim(baseClaim({ claimToken: 'claim-2', nowUnixMs: 2_000 })).kind).toBe('claimed');

    expect(() =>
      ledger.confirm({
        cluster: 'devnet',
        authority: 'authority-1',
        positionMint: 'mint-1',
        epoch: 42,
        claimToken: 'claim-1',
        nowUnixMs: 2_100,
        txSignature: 'sig-stale',
        onChainReceiptVerified: false,
      }),
    ).toThrow(/claim token/);
    ledger.close();
  });
});
