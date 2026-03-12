import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRunId, writeResultArtifact } from '../e2e/resultArtifact';

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('resultArtifact', () => {
  it('writes schemaVersion=1 and stable assertion ordering', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'm17-artifact-'));
    cleanupDirs.push(dir);

    const runId = buildRunId({ nowMs: 1_700_000_000_000, scenarioName: 'happy-path-trigger', position: 'abc' });
    const filePath = await writeResultArtifact({
      baseDir: dir,
      scenarioName: 'happy-path-trigger',
      artifact: {
        schemaVersion: 1,
        runId,
        timestamp: '2023-11-14T22:13:20.000Z',
        cluster: 'devnet',
        rpcUrl: 'http://127.0.0.1:8899',
        position: 'p',
        whirlpool: 'w',
        authority: 'a',
        decision: 'TRIGGER_DOWN',
        decisionReasonCode: 'FORCED_TRIGGER_DOWN',
        swapRouter: 'noop',
        swapPlanned: false,
        swapSkipped: true,
        swapSkipReason: 'ROUTER_DISABLED',
        txBuilt: false,
        txSimulated: false,
        txSent: false,
        txSignature: '',
        receiptPda: '',
        receiptFoundBefore: false,
        receiptFoundAfter: false,
        status: 'HOLD',
        skipReason: '',
        assertions: [
          { name: 'z.last', pass: true, actual: 1, expected: 1 },
          { name: 'a.first', pass: true, actual: 1, expected: 1 },
        ],
        errors: [],
        scenarioName: 'happy-path-trigger',
      },
    });

    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as { schemaVersion: number; assertions: Array<{ name: string }> };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.assertions.map((item) => item.name)).toEqual(['a.first', 'z.last']);
  });
});
