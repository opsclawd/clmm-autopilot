import { createHash } from 'node:crypto';
import type { AutopilotConfig, ReceiptIdlHashMode } from '@clmm-autopilot/core';
import { PublicKey } from '@solana/web3.js';
import defaultManifestJson from '../../../deployments/devnet/receipt.json';
import defaultReceiptIdlJson from '../../../deployments/devnet/receipt.idl.json';
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

const DEFAULT_DEVNET_MANIFEST = defaultManifestJson as ReceiptDeploymentManifest;
const DEFAULT_DEVNET_IDL = defaultReceiptIdlJson as unknown;
const KNOWN_IDL_ARTIFACTS: Record<string, unknown> = {
  'deployments/devnet/receipt.idl.json': DEFAULT_DEVNET_IDL,
};

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
  return DEFAULT_DEVNET_MANIFEST;
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
  const artifact = KNOWN_IDL_ARTIFACTS[normalized];
  if (artifact === undefined) {
    fail('RECEIPT_IDL_MISMATCH', `${source}.idlPath could not be loaded`, {
      idlPath,
      normalizedIdlPath: normalized,
      available: Object.keys(KNOWN_IDL_ARTIFACTS),
    });
  }
  return artifact as ReceiptIdlArtifact;
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

function assertConfigIdentity(config: AutopilotConfig): void {
  if (!config.receiptProgramId || !config.receiptIdlHashMode || !config.receiptIdlHash || !config.receiptIdlPath) {
    fail('RECEIPT_PROGRAM_NOT_CONFIGURED', 'Config fallback receipt identity is not fully configured', {
      receiptProgramId: config.receiptProgramId,
      receiptIdlHashMode: config.receiptIdlHashMode,
      receiptIdlHash: config.receiptIdlHash,
      receiptIdlPath: config.receiptIdlPath,
    });
  }

  const programId = parseRequiredProgramId(config.receiptProgramId, 'config');
  assertHashMode(config.receiptIdlHashMode, 'config');
  const idl = assertReceiptProgramMatchesIdlAddress(programId, config.receiptIdlPath, 'config');
  assertHashMatches(config.receiptIdlHash, idl, 'config');
}

export function resolveReceiptRuntimeIdentity(
  config: AutopilotConfig,
  env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {},
): ReceiptRuntimeIdentity | null {
  const forceConfig = env.RECEIPT_IDENTITY_SOURCE === 'config';
  const shouldUseManifest = config.cluster === 'devnet' && !forceConfig;

  if (shouldUseManifest) {
    const manifest = DEFAULT_DEVNET_MANIFEST;
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

  const fallbackProgramId = config.receiptProgramId;
  const fallbackHashMode = config.receiptIdlHashMode;
  const fallbackHash = config.receiptIdlHash;
  const fallbackIdlPath = config.receiptIdlPath;

  const fallbackConfigured = Boolean(
    fallbackProgramId && fallbackHashMode && fallbackHash && fallbackIdlPath,
  );

  if (config.cluster !== 'devnet') {
    return null;
  }

  if (!fallbackConfigured) {
    if (config.cluster === 'devnet') {
      assertConfigIdentity(config);
    }
    return null;
  }

  assertConfigIdentity(config);

  const idlHashMode = assertHashMode(fallbackHashMode!, 'config');
  const programId = parseRequiredProgramId(fallbackProgramId!, 'config');
  const configIdl = assertReceiptProgramMatchesIdlAddress(programId, fallbackIdlPath!, 'config');
  const idlHash = assertHashMatches(fallbackHash!, configIdl, 'config');

  return {
    source: 'config',
    programId,
    idlPath: fallbackIdlPath!,
    idlHashMode,
    idlHash,
    expectedUpgradeAuthority: parseOptionalPubkey(config.expectedUpgradeAuthority, 'config.expectedUpgradeAuthority'),
  };
}
