import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { PromptState, CertificationFailurePhase } from '../executeOnce';
import type { CertificationDirection, CertificationExecutionClass, CertificationScenarioId } from './scenarios';

export type CertificationStatus = 'PASS' | 'FAIL' | 'HOLD' | 'EXPECTED_FAILURE' | 'SKIPPED';

export type AssertionResult = {
  name: string;
  pass: boolean;
  actual: unknown;
  expected: unknown;
  reasonCode?: string;
  detail?: string;
};

export type ResultArtifact = {
  schemaVersion: 2;
  runId: string;
  timestamp: string;
  cluster: string;
  rpcUrl: string;
  authority: string;
  position: string;
  whirlpool: string;
  scenarioId: CertificationScenarioId;
  scenarioName: string;
  direction: CertificationDirection;
  status: CertificationStatus;
  skipReason: string;
  decision: string;
  decisionReasonCode: string;
  swapRouter: string;
  swapPlanned: boolean;
  swapSkipped: boolean;
  swapSkipReason: string;
  txBuilt: boolean;
  txSimulated: boolean;
  txSent: boolean;
  txSignature: string;
  receiptPda: string;
  receiptFoundBefore: boolean;
  receiptFoundAfter: boolean;
  failurePhase?: CertificationFailurePhase;
  assertions: AssertionResult[];
  errors: Array<{ code: string; message: string }>;
  fixture: {
    source: 'explicit-position' | 'directional-candidates';
    selectedPosition: string;
    freshFixtureRequired: boolean;
    exclusions: Array<{ position: string; reasonCode: string; detail?: string }>;
  };
  expectedOutcome: {
    executionClass: CertificationExecutionClass;
    walletPromptExpected: boolean;
    expectedStatus: CertificationStatus;
    expectedErrorCodes: string[];
    expectedFailurePhase?: CertificationFailurePhase;
    liveSendRequired: boolean;
  };
  timing: {
    startedAt: string;
    durationMs: number;
  };
  prompt: {
    expected: boolean;
    state: PromptState;
    walletPromptCount: number;
  };
  tx: {
    built: boolean;
    simulated: boolean;
    sent: boolean;
    signature: string;
    receiptPda: string;
  };
  quote: {
    ageMs: number;
    freshnessThresholdMs: number;
    freshnessThresholdSlots: number;
    rebuildHappened: boolean;
    rebuildReason?: string;
    slippageCapBps: number;
    minOut: string;
  };
  retries: {
    attemptsByOperation: Record<string, number>;
    exhausted: boolean;
    exhaustedKey?: string;
  };
  blockhash: {
    refreshed: boolean;
    sendAttempts: number;
  };
  localReceipt: {
    precheckStatus: 'not_configured' | 'clear' | 'pending' | 'confirmed' | 'failed';
    claimed: boolean;
    confirmed: boolean;
    terminalStatus: 'not_configured' | 'clear' | 'pending' | 'confirmed' | 'failed';
    dbPath?: string;
  };
  postTrade: {
    liquidityBefore: string;
    liquidityAfter: string;
    tokenADelta: string;
    tokenBDelta: string;
    solLamportDelta: string;
    feeCollectionReason: string;
    portfolioShapeVerdict: 'not_checked' | 'pass' | 'fail';
    duplicateBlocked: boolean;
  };
  operatorSummary: {
    triggerDirection: CertificationDirection;
    position: string;
    whirlpool: string;
    attempted: string;
    signed: string;
    sent: string;
    confirmed: string;
    errorCode?: string;
  };
};

const DEFAULT_ARTIFACT_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../artifacts/e2e/devnet',
);

export function defaultArtifactBaseDir(): string {
  return DEFAULT_ARTIFACT_DIR;
}

export function sanitizeRpcUrl(input: string): string {
  try {
    const parsed = new URL(input);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return input;
  }
}

function sanitizeRunIdPart(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

export function buildRunId(params: { nowMs: number; scenarioName: string; position?: string }): string {
  const when = new Date(params.nowMs).toISOString().replace(/[:.]/g, '-');
  const scenario = sanitizeRunIdPart(params.scenarioName || 'scenario');
  const position = sanitizeRunIdPart((params.position ?? 'na').slice(0, 12));
  return `${when}--${scenario}--${position}`;
}

function sortAssertions(assertions: AssertionResult[]): AssertionResult[] {
  return [...assertions].sort((a, b) => a.name.localeCompare(b.name));
}

function sortErrors(errors: Array<{ code: string; message: string }>): Array<{ code: string; message: string }> {
  return [...errors].sort((a, b) => `${a.code}:${a.message}`.localeCompare(`${b.code}:${b.message}`));
}

function sortExclusions(
  exclusions: Array<{ position: string; reasonCode: string; detail?: string }>,
): Array<{ position: string; reasonCode: string; detail?: string }> {
  return [...exclusions].sort((a, b) => `${a.position}:${a.reasonCode}`.localeCompare(`${b.position}:${b.reasonCode}`));
}

export function normalizeArtifact(artifact: ResultArtifact): ResultArtifact {
  return {
    ...artifact,
    schemaVersion: 2,
    assertions: sortAssertions(artifact.assertions),
    errors: sortErrors(artifact.errors),
    fixture: {
      ...artifact.fixture,
      exclusions: sortExclusions(artifact.fixture.exclusions),
    },
    retries: {
      ...artifact.retries,
      attemptsByOperation: Object.fromEntries(
        Object.entries(artifact.retries.attemptsByOperation).sort(([a], [b]) => a.localeCompare(b)),
      ),
    },
  };
}

export async function writeResultArtifact(params: {
  artifact: ResultArtifact;
  scenarioName: string;
  baseDir?: string;
}): Promise<string> {
  const dir = resolve(params.baseDir ?? DEFAULT_ARTIFACT_DIR, params.scenarioName);
  await mkdir(dir, { recursive: true });
  const normalized = normalizeArtifact(params.artifact);
  const filePath = resolve(dir, `${normalized.runId}.json`);
  await writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return filePath;
}
