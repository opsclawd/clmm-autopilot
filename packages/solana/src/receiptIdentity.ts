import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AutopilotConfig, ReceiptIdlHashMode } from '@clmm-autopilot/core';
import { PublicKey } from '@solana/web3.js';
import type { CanonicalErrorCode } from './types';

export type ReceiptDeploymentManifest = {
  cluster: 'devnet';
  programId: string;
  idlPath: string;
  idlHashMode: ReceiptIdlHashMode;
  idlHash: string;
  deployedAt: string;
  gitCommit: string;
  deployerPubkey?: string;
  expectedUpgradeAuthority?: string;
};

export type ReceiptRuntimeIdentity = {
  source: 'manifest' | 'config';
  programId: PublicKey;
  idlPath: string;
  idlHashMode: ReceiptIdlHashMode;
  idlHash: string;
  expectedUpgradeAuthority?: PublicKey;
};

export type ReceiptIdlArg =
  | { name: string; type: 'u32' | 'u8' | 'pubkey' }
  | { name: string; type: { array: ['u8', number] } };

export type ReceiptIdlInstruction = {
  name: string;
  discriminator?: number[];
  accounts?: Array<{ name: string; writable?: boolean; signer?: boolean; address?: string }>;
  args?: ReceiptIdlArg[];
};

export type ReceiptIdlArtifact = {
  address?: string;
  instructions?: ReceiptIdlInstruction[];
};

type TypedError = Error & { code: CanonicalErrorCode; retryable: boolean; debug?: unknown };

type ReceiptIdlFullV1 = {
  version: 'full-v1';
  idl: unknown;
};

const DEVNET_MANIFEST_PATH = 'deployments/devnet/receipt.json';
const DEVNET_IDL_PATH = 'deployments/devnet/receipt.idl.json';
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, '../../..');
const KNOWN_IDL_ARTIFACT_PATHS: Record<string, string> = {
  [DEVNET_IDL_PATH]: resolve(REPO_ROOT, DEVNET_IDL_PATH),
};
let defaultDevnetManifestCache: ReceiptDeploymentManifest | undefined;
const idlArtifactCache = new Map<string, ReceiptIdlArtifact>();

function fail(code: CanonicalErrorCode, message: string, debug?: unknown): never {
  const err = new Error(message) as TypedError;
  err.code = code;
  err.retryable = false;
  if (debug !== undefined) err.debug = debug;
  throw err;
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => normalizeJson(v));
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = normalizeJson(v);
    return out;
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

function readJsonFromDisk(
  absolutePath: string,
  code: CanonicalErrorCode,
  message: string,
  debugContext: Record<string, unknown>,
): unknown {
  let raw: string;
  try {
    raw = readFileSync(absolutePath, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(code, message, { ...debugContext, absolutePath, detail });
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(code, message, { ...debugContext, absolutePath, detail });
  }
}

export function canonicalizeReceiptIdlFullV1(idl: unknown): ReceiptIdlFullV1 {
  return {
    version: 'full-v1',
    idl: normalizeJson(idl),
  };
}

export function computeReceiptIdlHashFullV1(idl: unknown): string {
  const canonicalized = canonicalizeReceiptIdlFullV1(idl);
  const canonical = stableStringify(canonicalized);
  return createHash('sha256').update(canonical).digest('hex');
}

export function getDefaultDevnetReceiptManifest(): ReceiptDeploymentManifest {
  if (defaultDevnetManifestCache) {
    return defaultDevnetManifestCache;
  }

  const manifestRaw = readJsonFromDisk(
    resolve(REPO_ROOT, DEVNET_MANIFEST_PATH),
    'RECEIPT_PROGRAM_NOT_CONFIGURED',
    'manifest identity could not be loaded',
    { manifestPath: DEVNET_MANIFEST_PATH },
  );
  if (!manifestRaw || typeof manifestRaw !== 'object' || Array.isArray(manifestRaw)) {
    fail('RECEIPT_PROGRAM_NOT_CONFIGURED', 'manifest identity must be a JSON object', {
      manifestPath: DEVNET_MANIFEST_PATH,
      receivedType: typeof manifestRaw,
    });
  }

  defaultDevnetManifestCache = manifestRaw as ReceiptDeploymentManifest;
  return defaultDevnetManifestCache;
}

function parseOptionalPubkey(value: string | undefined, path: string): PublicKey | undefined {
  if (!value) return undefined;
  try {
    return new PublicKey(value);
  } catch {
    fail('RECEIPT_PROGRAM_NOT_CONFIGURED', `${path} must be a valid base58 public key`, { value });
  }
}

function parseRequiredProgramId(value: string, source: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    fail('RECEIPT_PROGRAM_NOT_CONFIGURED', `${source}.programId must be a valid base58 public key`, { value });
  }
}

function assertHashMode(value: string | undefined, source: string): ReceiptIdlHashMode {
  if (value !== 'full-v1') {
    fail('RECEIPT_IDL_MISMATCH', `${source}.idlHashMode must be 'full-v1'`, { value });
  }
  return value;
}

function assertHashMatches(expected: string, idl: unknown, source: string): string {
  if (!/^[a-f0-9]{64}$/i.test(expected)) {
    fail('RECEIPT_IDL_MISMATCH', `${source}.idlHash must be a 64-char hex sha256`, { expected });
  }
  const computed = computeReceiptIdlHashFullV1(idl);
  if (computed.toLowerCase() !== expected.toLowerCase()) {
    fail('RECEIPT_IDL_MISMATCH', `${source}.idlHash does not match runtime IDL hash`, {
      expected: expected.toLowerCase(),
      actual: computed.toLowerCase(),
    });
  }
  return computed.toLowerCase();
}

function normalizeIdlPath(idlPath: string): string {
  let normalized = idlPath.trim().replace(/\\/g, '/');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  return normalized;
}

export function loadReceiptIdlArtifact(idlPath: string, source = 'receipt'): ReceiptIdlArtifact {
  const normalized = normalizeIdlPath(idlPath);
  const cached = idlArtifactCache.get(normalized);
  if (cached) return cached;

  const artifactPath = KNOWN_IDL_ARTIFACT_PATHS[normalized];
  if (!artifactPath) {
    fail('RECEIPT_IDL_MISMATCH', `${source}.idlPath could not be loaded`, {
      idlPath,
      normalizedIdlPath: normalized,
      available: Object.keys(KNOWN_IDL_ARTIFACT_PATHS),
    });
  }

  const artifactRaw = readJsonFromDisk(
    artifactPath,
    'RECEIPT_IDL_MISMATCH',
    `${source}.idlPath could not be loaded`,
    {
      idlPath,
      normalizedIdlPath: normalized,
      available: Object.keys(KNOWN_IDL_ARTIFACT_PATHS),
    },
  );
  if (!artifactRaw || typeof artifactRaw !== 'object' || Array.isArray(artifactRaw)) {
    fail('RECEIPT_IDL_MISMATCH', `${source}.idlPath could not be loaded`, {
      idlPath,
      normalizedIdlPath: normalized,
      receivedType: typeof artifactRaw,
      available: Object.keys(KNOWN_IDL_ARTIFACT_PATHS),
    });
  }

  const artifact = artifactRaw as ReceiptIdlArtifact;
  idlArtifactCache.set(normalized, artifact);
  return artifact;
}

export function assertReceiptProgramMatchesIdlAddress(
  programId: PublicKey | string,
  idlPath: string,
  source: string,
): ReceiptIdlArtifact {
  const idl = loadReceiptIdlArtifact(idlPath, source);
  const expectedProgramId = typeof programId === 'string' ? programId : programId.toBase58();
  const actualProgramId = typeof idl.address === 'string' ? idl.address.trim() : '';
  if (!actualProgramId) {
    fail('RECEIPT_IDL_MISMATCH', `${source}.address missing from receipt IDL`, { idlPath, expectedProgramId });
  }
  if (actualProgramId !== expectedProgramId) {
    fail('RECEIPT_IDL_MISMATCH', `${source}.address does not match receipt program id`, {
      expectedProgramId,
      actualProgramId,
      idlPath,
    });
  }
  return idl;
}

function assertConfigIdentity(config: AutopilotConfig): {
  programId: PublicKey;
  idlHashMode: ReceiptRuntimeIdentity['idlHashMode'];
  idlHash: string;
} {
  if (!config.receiptProgramId || !config.receiptIdlHashMode || !config.receiptIdlHash || !config.receiptIdlPath) {
    fail('RECEIPT_PROGRAM_NOT_CONFIGURED', 'Config fallback receipt identity is not fully configured', {
      receiptProgramId: config.receiptProgramId,
      receiptIdlHashMode: config.receiptIdlHashMode,
      receiptIdlHash: config.receiptIdlHash,
      receiptIdlPath: config.receiptIdlPath,
    });
  }

  const programId = parseRequiredProgramId(config.receiptProgramId, 'config');
  const idlHashMode = assertHashMode(config.receiptIdlHashMode, 'config');
  if (!/^[a-f0-9]{64}$/i.test(config.receiptIdlHash)) {
    fail('RECEIPT_IDL_MISMATCH', 'config.idlHash must be a 64-char hex sha256', {
      expected: config.receiptIdlHash,
    });
  }

  const idl = assertReceiptProgramMatchesIdlAddress(programId, config.receiptIdlPath, 'config');
  const idlHash = assertHashMatches(config.receiptIdlHash, idl, 'config');
  return { programId, idlHashMode, idlHash };
}

export function resolveReceiptRuntimeIdentity(
  config: AutopilotConfig,
  env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {},
): ReceiptRuntimeIdentity | null {
  const forceConfig = env.RECEIPT_IDENTITY_SOURCE === 'config';
  if (forceConfig) {
    // Forced fallback mode must validate config identity even on non-devnet clusters.
    const { programId, idlHashMode, idlHash } = assertConfigIdentity(config);

    return {
      source: 'config',
      programId,
      idlPath: config.receiptIdlPath!,
      idlHashMode,
      idlHash,
      expectedUpgradeAuthority: parseOptionalPubkey(config.expectedUpgradeAuthority, 'config.expectedUpgradeAuthority'),
    };
  }

  if (config.cluster !== 'devnet') {
    if (!config.receiptProgramId || !config.receiptIdlHashMode || !config.receiptIdlHash || !config.receiptIdlPath) {
      return null;
    }
    const { programId, idlHashMode, idlHash } = assertConfigIdentity(config);
    return {
      source: 'config',
      programId,
      idlPath: config.receiptIdlPath,
      idlHashMode,
      idlHash,
      expectedUpgradeAuthority: parseOptionalPubkey(config.expectedUpgradeAuthority, 'config.expectedUpgradeAuthority'),
    };
  }

  const manifest = getDefaultDevnetReceiptManifest();
  const programId = parseRequiredProgramId(manifest.programId, 'manifest');
  const idlHashMode = assertHashMode(manifest.idlHashMode, 'manifest');
  const manifestIdl = assertReceiptProgramMatchesIdlAddress(programId, manifest.idlPath, 'manifest');
  const idlHash = assertHashMatches(manifest.idlHash, manifestIdl, 'manifest');
  return {
    source: 'manifest',
    programId,
    idlPath: manifest.idlPath,
    idlHashMode,
    idlHash,
    expectedUpgradeAuthority: parseOptionalPubkey(manifest.expectedUpgradeAuthority, 'manifest.expectedUpgradeAuthority'),
  };
}
