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

type TypedError = Error & { code: CanonicalErrorCode; retryable: boolean; debug?: unknown };

type ReceiptIdlSubsetV1 = {
  version: 'subset-v1';
  address: string | null;
  instructions: Array<{
    name: string;
    discriminator: number[];
    accounts: Array<{
      name: string;
      writable: boolean;
      signer: boolean;
      address?: string;
      pda?: unknown;
    }>;
    args: Array<{ name: string; type: unknown }>;
  }>;
  accounts: Array<{ name: string; discriminator: number[] }>;
  types: Array<{ name: string; type: unknown }>;
};

const DEFAULT_DEVNET_MANIFEST = defaultManifestJson as ReceiptDeploymentManifest;
const DEFAULT_DEVNET_IDL = defaultReceiptIdlJson as unknown;
const KNOWN_IDL_ARTIFACTS: Record<string, unknown> = {
  'deployments/devnet/receipt.idl.json': DEFAULT_DEVNET_IDL,
};

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

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

function parseDiscriminator(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const n of value) {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 255) {
      return [];
    }
    out.push(n);
  }
  return out;
}

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

function sha256(bytes: Uint8Array): Uint8Array {
  const bitLen = BigInt(bytes.length) * BigInt(8);
  const padLen = (((bytes.length + 9 + 63) >> 6) << 6) - bytes.length;
  const msg = new Uint8Array(bytes.length + padLen);
  msg.set(bytes);
  msg[bytes.length] = 0x80;
  for (let i = 0; i < 8; i += 1) {
    const shift = BigInt((7 - i) * 8);
    msg[msg.length - 8 + i] = Number((bitLen >> shift) & BigInt(0xff));
  }

  const view = new DataView(msg.buffer);
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const W = new Uint32Array(64);

  for (let i = 0; i < msg.length; i += 64) {
    for (let t = 0; t < 16; t += 1) W[t] = view.getUint32(i + t * 4, false);
    for (let t = 16; t < 64; t += 1) {
      const s0 = rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3);
      const s1 = rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[t] + W[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    H[0] = (H[0] + a) >>> 0;
    H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0;
    H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0;
    H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0;
    H[7] = (H[7] + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) outView.setUint32(i * 4, H[i], false);
  return out;
}

export function canonicalizeReceiptIdlSubsetV1(idl: unknown): ReceiptIdlSubsetV1 {
  const root = idl && typeof idl === 'object' ? (idl as Record<string, unknown>) : {};

  const instructionsRaw = Array.isArray(root.instructions) ? root.instructions : [];
  const instructions = instructionsRaw.map((ixRaw): ReceiptIdlSubsetV1['instructions'][number] => {
    const ix = ixRaw && typeof ixRaw === 'object' ? (ixRaw as Record<string, unknown>) : {};
    const accountsRaw = Array.isArray(ix.accounts) ? ix.accounts : [];
    const argsRaw = Array.isArray(ix.args) ? ix.args : [];

    return {
      name: typeof ix.name === 'string' ? ix.name : '',
      discriminator: parseDiscriminator(ix.discriminator),
      accounts: accountsRaw.map((accRaw) => {
        const acc = accRaw && typeof accRaw === 'object' ? (accRaw as Record<string, unknown>) : {};
        return {
          name: typeof acc.name === 'string' ? acc.name : '',
          writable: acc.writable === true,
          signer: acc.signer === true,
          ...(typeof acc.address === 'string' ? { address: acc.address } : {}),
          ...(acc.pda !== undefined ? { pda: normalizeJson(acc.pda) } : {}),
        };
      }),
      args: argsRaw.map((argRaw) => {
        const arg = argRaw && typeof argRaw === 'object' ? (argRaw as Record<string, unknown>) : {};
        return {
          name: typeof arg.name === 'string' ? arg.name : '',
          type: normalizeJson(arg.type),
        };
      }),
    };
  });

  const accountsRaw = Array.isArray(root.accounts) ? root.accounts : [];
  const accounts = accountsRaw.map((accRaw) => {
    const acc = accRaw && typeof accRaw === 'object' ? (accRaw as Record<string, unknown>) : {};
    return {
      name: typeof acc.name === 'string' ? acc.name : '',
      discriminator: parseDiscriminator(acc.discriminator),
    };
  });

  const typesRaw = Array.isArray(root.types) ? root.types : [];
  const types = typesRaw
    .map((typeRaw) => {
      const t = typeRaw && typeof typeRaw === 'object' ? (typeRaw as Record<string, unknown>) : {};
      return {
        name: typeof t.name === 'string' ? t.name : '',
        type: normalizeJson(t.type),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    version: 'subset-v1',
    address: typeof root.address === 'string' ? root.address : null,
    instructions,
    accounts,
    types,
  };
}

export function computeReceiptIdlHashSubsetV1(idl: unknown): string {
  const subset = canonicalizeReceiptIdlSubsetV1(idl);
  const canonical = stableStringify(subset);
  const digest = sha256(new TextEncoder().encode(canonical));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
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
  if (value !== 'subset-v1') {
    fail('RECEIPT_IDL_MISMATCH', `${source}.idlHashMode must be 'subset-v1'`, { value });
  }
  return value;
}

function assertHashMatches(expected: string, idl: unknown, source: string): string {
  if (!/^[a-f0-9]{64}$/i.test(expected)) {
    fail('RECEIPT_IDL_MISMATCH', `${source}.idlHash must be a 64-char hex sha256`, { expected });
  }
  const computed = computeReceiptIdlHashSubsetV1(idl);
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

function readIdlFromPath(idlPath: string, source: string): unknown {
  const normalized = normalizeIdlPath(idlPath);
  const artifact = KNOWN_IDL_ARTIFACTS[normalized];
  if (artifact === undefined) {
    fail('RECEIPT_IDL_MISMATCH', `${source}.idlPath could not be loaded`, {
      idlPath,
      normalizedIdlPath: normalized,
      available: Object.keys(KNOWN_IDL_ARTIFACTS),
    });
  }
  return artifact;
}

export function resolveReceiptRuntimeIdentity(
  config: AutopilotConfig,
  env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {},
): ReceiptRuntimeIdentity | null {
  const forceConfig = env.RECEIPT_IDENTITY_SOURCE === 'config';
  const shouldUseManifest = config.cluster === 'devnet' && !forceConfig;

  if (shouldUseManifest) {
    const manifest = DEFAULT_DEVNET_MANIFEST;
    const idlHashMode = assertHashMode(manifest.idlHashMode, 'manifest');
    const manifestIdl = readIdlFromPath(manifest.idlPath, 'manifest');
    const idlHash = assertHashMatches(manifest.idlHash, manifestIdl, 'manifest');
    return {
      source: 'manifest',
      programId: parseRequiredProgramId(manifest.programId, 'manifest'),
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

  if (config.cluster !== 'devnet' && env.RECEIPT_ENABLE_NON_DEVNET !== '1') {
    return null;
  }

  if (!fallbackConfigured) {
    if (config.cluster === 'devnet') {
      fail('RECEIPT_PROGRAM_NOT_CONFIGURED', 'Devnet receipt identity is not fully configured', {
        receiptProgramId: fallbackProgramId,
        receiptIdlHashMode: fallbackHashMode,
        receiptIdlHash: fallbackHash,
        receiptIdlPath: fallbackIdlPath,
      });
    }
    return null;
  }

  const idlHashMode = assertHashMode(fallbackHashMode!, 'config');
  const configIdl = readIdlFromPath(fallbackIdlPath!, 'config');
  const idlHash = assertHashMatches(fallbackHash!, configIdl, 'config');

  return {
    source: 'config',
    programId: parseRequiredProgramId(fallbackProgramId!, 'config'),
    idlPath: fallbackIdlPath!,
    idlHashMode,
    idlHash,
    expectedUpgradeAuthority: parseOptionalPubkey(config.expectedUpgradeAuthority, 'config.expectedUpgradeAuthority'),
  };
}
