import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export type CertificationStatus = 'PASS' | 'FAIL' | 'HOLD' | 'EXPECTED_FAILURE' | 'SKIPPED';

export type AssertionResult = {
  name: string;
  pass: boolean;
  actual: unknown;
  expected: unknown;
  reasonCode?: string;
  detail?: string;
};

export type ResultArtifactV1 = {
  schemaVersion: 1;
  runId: string;
  timestamp: string;
  cluster: string;
  rpcUrl: string;
  position: string;
  whirlpool: string;
  authority: string;
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
  status: CertificationStatus;
  skipReason: string;
  assertions: AssertionResult[];
  errors: Array<{ code: string; message: string }>;
  scenarioName: string;
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

export function normalizeArtifact(artifact: ResultArtifactV1): ResultArtifactV1 {
  return {
    schemaVersion: 1,
    runId: artifact.runId,
    timestamp: artifact.timestamp,
    cluster: artifact.cluster,
    rpcUrl: artifact.rpcUrl,
    position: artifact.position,
    whirlpool: artifact.whirlpool,
    authority: artifact.authority,
    decision: artifact.decision,
    decisionReasonCode: artifact.decisionReasonCode,
    swapRouter: artifact.swapRouter,
    swapPlanned: artifact.swapPlanned,
    swapSkipped: artifact.swapSkipped,
    swapSkipReason: artifact.swapSkipReason,
    txBuilt: artifact.txBuilt,
    txSimulated: artifact.txSimulated,
    txSent: artifact.txSent,
    txSignature: artifact.txSignature,
    receiptPda: artifact.receiptPda,
    receiptFoundBefore: artifact.receiptFoundBefore,
    receiptFoundAfter: artifact.receiptFoundAfter,
    status: artifact.status,
    skipReason: artifact.skipReason,
    assertions: sortAssertions(artifact.assertions),
    errors: [...artifact.errors],
    scenarioName: artifact.scenarioName,
  };
}

export async function writeResultArtifact(params: {
  artifact: ResultArtifactV1;
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
