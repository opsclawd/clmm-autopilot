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
  it('writes schemaVersion=2 and stable ordering for assertions and fixture exclusions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'm17-artifact-'));
    cleanupDirs.push(dir);

    const runId = buildRunId({ nowMs: 1_700_000_000_000, scenarioName: 'down-happy-path-execute', position: 'abc' });
    const filePath = await writeResultArtifact({
      baseDir: dir,
      scenarioName: 'down-happy-path-execute',
      artifact: {
        schemaVersion: 2,
        runId,
        timestamp: '2023-11-14T22:13:20.000Z',
        cluster: 'devnet',
        rpcUrl: 'http://127.0.0.1:8899',
        authority: 'a',
        position: 'p',
        whirlpool: 'w',
        scenarioId: 'happy-path-execute',
        scenarioName: 'down-happy-path-execute',
        direction: 'DOWN',
        status: 'HOLD',
        skipReason: '',
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
        assertions: [
          { name: 'z.last', pass: true, actual: 1, expected: 1 },
          { name: 'a.first', pass: true, actual: 1, expected: 1 },
        ],
        errors: [],
        fixture: {
          source: 'directional-candidates',
          selectedPosition: 'p',
          freshFixtureRequired: true,
          exclusions: [
            { position: 'z', reasonCode: 'WRONG_DIRECTION_SHAPE' },
            { position: 'a', reasonCode: 'NOT_SOL_USDC' },
          ],
        },
        expectedOutcome: {
          executionClass: 'live_send_success',
          walletPromptExpected: true,
          expectedStatus: 'PASS',
          expectedErrorCodes: [],
          liveSendRequired: true,
        },
        timing: {
          startedAt: '2023-11-14T22:13:20.000Z',
          durationMs: 100,
        },
        prompt: {
          expected: true,
          state: 'prompt_not_reached',
          walletPromptCount: 0,
        },
        tx: {
          built: false,
          simulated: false,
          sent: false,
          signature: '',
          receiptPda: '',
        },
        quote: {
          ageMs: 0,
          freshnessThresholdMs: 1_000,
          freshnessThresholdSlots: 2,
          rebuildHappened: false,
          slippageCapBps: 50,
          minOut: '0',
        },
        retries: {
          attemptsByOperation: { z: 1, a: 2 },
          exhausted: false,
        },
        blockhash: {
          refreshed: false,
          sendAttempts: 0,
        },
        localReceipt: {
          precheckStatus: 'clear',
          claimed: false,
          confirmed: false,
          terminalStatus: 'clear',
        },
        postTrade: {
          liquidityBefore: '0',
          liquidityAfter: '0',
          tokenADelta: '0',
          tokenBDelta: '0',
          solLamportDelta: '0',
          feeCollectionReason: 'NOT_CHECKED',
          portfolioShapeVerdict: 'not_checked',
          duplicateBlocked: false,
        },
        operatorSummary: {
          triggerDirection: 'DOWN',
          position: 'p',
          whirlpool: 'w',
          attempted: 'not_built',
          signed: 'prompt_not_reached',
          sent: 'not_sent',
          confirmed: 'HOLD',
        },
      },
    });

    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as {
      schemaVersion: number;
      assertions: Array<{ name: string }>;
      fixture: { exclusions: Array<{ position: string }> };
      retries: { attemptsByOperation: Record<string, number> };
    };
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.assertions.map((item) => item.name)).toEqual(['a.first', 'z.last']);
    expect(parsed.fixture.exclusions.map((item) => item.position)).toEqual(['a', 'z']);
    expect(Object.keys(parsed.retries.attemptsByOperation)).toEqual(['a', 'z']);
  });
});
