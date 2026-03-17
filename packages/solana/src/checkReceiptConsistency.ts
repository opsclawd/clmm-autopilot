import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, type Cluster } from '@clmm-autopilot/core';
import { Connection } from '@solana/web3.js';
import {
  resolveReceiptRuntimeIdentity,
  type ReceiptDeploymentManifest,
  type ReceiptVerifiedBuildMetadata,
} from './receiptIdentity';
import { verifyReceiptProgramOnChain } from './receiptProgramVerification';

export type ReceiptConsistencyResult = {
  cluster: Cluster;
  manifestPath: string;
  programId: string;
  idlPath: string;
  idlHash: string;
  idlHashMode: string;
  programBinaryPath?: string;
  programBinarySha256?: string;
  observedUpgradeAuthority?: string;
  deployedSlot?: number;
};

type CheckReceiptConsistencyOptions = {
  cluster: Extract<Cluster, 'devnet' | 'mainnet'>;
  manifestPath?: string;
  repoRoot?: string;
  rpcUrl?: string;
};

function fail(message: string, debug?: unknown): never {
  const detail = debug ? `\n${JSON.stringify(debug, null, 2)}` : '';
  throw new Error(`${message}${detail}`);
}

function assertEqual(name: string, actual: string, expected: string): void {
  if (actual !== expected) {
    fail(`${name} mismatch`, { actual, expected });
  }
}

function assertStringField(
  source: Record<string, unknown>,
  field: string,
  {
    allowUnknown = false,
  }: {
    allowUnknown?: boolean;
  } = {},
): string {
  const value = source[field];
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`Manifest field missing/invalid: ${field}`, { value });
  }
  if (!allowUnknown && value.trim().toLowerCase() === 'unknown') {
    fail(`Manifest field cannot be placeholder 'unknown': ${field}`, { value });
  }
  return value.trim();
}

function assertOptionalPubkey(source: Record<string, unknown>, field: string): string | undefined {
  const value = source[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) {
    fail(`Manifest field must be a base58 public key: ${field}`, { value });
  }
  return value;
}

function extractDeclareId(source: string): string {
  const match = source.match(/declare_id!\("([1-9A-HJ-NP-Za-km-z]{32,44})"\);/);
  if (!match?.[1]) {
    fail('Unable to parse programs/receipt/src/lib.rs declare_id!()');
  }
  return match[1];
}

function extractAnchorProgramId(source: string, cluster: 'devnet' | 'mainnet'): string {
  const match = source.match(
    new RegExp(`\\[programs\\.${cluster}\\][\\s\\S]*?receipt\\s*=\\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"`),
  );
  if (!match?.[1]) {
    fail(`Unable to parse Anchor.toml [programs.${cluster}].receipt`);
  }
  return match[1];
}

function computeFileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function assertTimestamp(value: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    fail('Manifest deployedAt is not a valid ISO timestamp', { deployedAt: value });
  }
  if (new Date(parsed).getUTCFullYear() < 2020) {
    fail('Manifest deployedAt is not plausible for a real deployment', { deployedAt: value });
  }
}

function assertGitCommit(value: string): void {
  if (!/^[a-f0-9]{7,40}$/i.test(value)) {
    fail('Manifest gitCommit must be a 7-40 char git hash', { gitCommit: value });
  }
}

function assertToolchain(manifest: Record<string, unknown>, requireVerify: boolean): void {
  const toolchain = manifest.toolchain;
  if (toolchain === undefined) return;
  if (!toolchain || typeof toolchain !== 'object' || Array.isArray(toolchain)) {
    fail('Manifest toolchain must be an object', { toolchain });
  }
  const typed = toolchain as Record<string, unknown>;
  assertStringField(typed, 'anchorVersion');
  assertStringField(typed, 'solanaVersion');
  if (requireVerify) {
    assertStringField(typed, 'solanaVerifyVersion');
  }
}

function assertVerifiedBuild(manifest: Record<string, unknown>, repoRoot: string): ReceiptVerifiedBuildMetadata | undefined {
  const verifiedBuild = manifest.verifiedBuild;
  if (verifiedBuild === undefined) return undefined;
  if (!verifiedBuild || typeof verifiedBuild !== 'object' || Array.isArray(verifiedBuild)) {
    fail('Manifest verifiedBuild must be an object', { verifiedBuild });
  }
  const typed = verifiedBuild as Record<string, unknown>;
  const tool = assertStringField(typed, 'tool');
  if (tool !== 'solana-verify') {
    fail("Manifest verifiedBuild.tool must be 'solana-verify'", { tool });
  }
  const version = assertStringField(typed, 'version');
  const evidencePath = assertStringField(typed, 'evidencePath');
  const executableHash = assertStringField(typed, 'executableHash');
  const programHash = assertStringField(typed, 'programHash');
  if (executableHash !== programHash) {
    fail('Manifest verifiedBuild hashes must match', { executableHash, programHash });
  }
  const absoluteEvidencePath = resolve(repoRoot, evidencePath);
  if (!existsSync(absoluteEvidencePath)) {
    fail('Manifest verifiedBuild evidencePath does not exist', { evidencePath, absoluteEvidencePath });
  }

  return {
    tool: 'solana-verify',
    version,
    evidencePath,
    executableHash,
    programHash,
  };
}

function validateManifest(
  manifestRaw: Record<string, unknown>,
  cluster: 'devnet' | 'mainnet',
  repoRoot: string,
): ReceiptDeploymentManifest {
  if (manifestRaw.cluster !== cluster) {
    fail(`Manifest cluster must be '${cluster}'`, { cluster: manifestRaw.cluster });
  }

  const programId = assertStringField(manifestRaw, 'programId');
  const idlPath = assertStringField(manifestRaw, 'idlPath');
  const idlHashMode = assertStringField(manifestRaw, 'idlHashMode');
  const idlHash = assertStringField(manifestRaw, 'idlHash');
  const deployedAt = assertStringField(manifestRaw, 'deployedAt');
  const gitCommit = assertStringField(manifestRaw, 'gitCommit');
  const deployerPubkey = assertOptionalPubkey(manifestRaw, 'deployerPubkey');
  const expectedUpgradeAuthority = assertOptionalPubkey(manifestRaw, 'expectedUpgradeAuthority');
  const observedUpgradeAuthority = assertOptionalPubkey(manifestRaw, 'observedUpgradeAuthority');

  assertTimestamp(deployedAt);
  assertGitCommit(gitCommit);
  assertToolchain(manifestRaw, cluster === 'mainnet');

  if (!/^[a-f0-9]{64}$/i.test(idlHash)) {
    fail('Manifest idlHash must be a 64-char hex sha256', { idlHash });
  }

  if (cluster === 'mainnet') {
    const programBinaryPath = assertStringField(manifestRaw, 'programBinaryPath');
    const programBinarySha256 = assertStringField(manifestRaw, 'programBinarySha256');
    if (!/^[a-f0-9]{64}$/i.test(programBinarySha256)) {
      fail('Manifest programBinarySha256 must be a 64-char hex sha256', { programBinarySha256 });
    }
    const deploySignature = assertStringField(manifestRaw, 'deploySignature');
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,88}$/.test(deploySignature)) {
      fail('Manifest deploySignature must look like a base58 signature', { deploySignature });
    }
    const deployedSlot = manifestRaw.deployedSlot;
    if (typeof deployedSlot !== 'number' || !Number.isInteger(deployedSlot) || deployedSlot <= 0) {
      fail('Manifest deployedSlot must be a positive integer', { deployedSlot });
    }
    const absoluteBinaryPath = resolve(repoRoot, programBinaryPath);
    if (!existsSync(absoluteBinaryPath)) {
      fail('Manifest programBinaryPath does not exist', { programBinaryPath, absoluteBinaryPath });
    }
    const actualBinaryHash = computeFileSha256(absoluteBinaryPath);
    if (actualBinaryHash !== programBinarySha256.toLowerCase()) {
      fail('Manifest programBinarySha256 does not match binary artifact', {
        programBinaryPath,
        expected: programBinarySha256.toLowerCase(),
        actual: actualBinaryHash,
      });
    }
    const verifiedBuild = assertVerifiedBuild(manifestRaw, repoRoot);
    return {
      cluster,
      programId,
      idlPath,
      idlHashMode: idlHashMode as ReceiptDeploymentManifest['idlHashMode'],
      idlHash: idlHash.toLowerCase(),
      deployedAt,
      gitCommit,
      deployerPubkey,
      expectedUpgradeAuthority,
      observedUpgradeAuthority,
      deploySignature,
      deployedSlot,
      programBinaryPath,
      programBinarySha256: programBinarySha256.toLowerCase(),
      verifiedBuild,
      toolchain: manifestRaw.toolchain as ReceiptDeploymentManifest['toolchain'],
    };
  }

  return {
    cluster,
    programId,
    idlPath,
    idlHashMode: idlHashMode as ReceiptDeploymentManifest['idlHashMode'],
    idlHash: idlHash.toLowerCase(),
    deployedAt,
    gitCommit,
    deployerPubkey,
    expectedUpgradeAuthority,
    observedUpgradeAuthority,
    toolchain: manifestRaw.toolchain as ReceiptDeploymentManifest['toolchain'],
  };
}

export async function checkReceiptConsistency({
  cluster,
  manifestPath,
  repoRoot,
  rpcUrl,
}: CheckReceiptConsistencyOptions): Promise<ReceiptConsistencyResult> {
  const srcDir = dirname(fileURLToPath(import.meta.url));
  const root = repoRoot ?? resolve(srcDir, '../../..');
  const selectedManifestPath = manifestPath ?? resolve(root, `deployments/${cluster}/receipt.json`);
  const libPath = resolve(root, 'programs/receipt/src/lib.rs');
  const anchorTomlPath = resolve(root, 'Anchor.toml');

  if (!existsSync(selectedManifestPath)) {
    fail('Manifest not found', { manifestPath: selectedManifestPath });
  }
  const manifestRaw = JSON.parse(readFileSync(selectedManifestPath, 'utf8')) as Record<string, unknown>;
  const manifest = validateManifest(manifestRaw, cluster, root);

  assertEqual('programs/receipt/src/lib.rs declare_id!', extractDeclareId(readFileSync(libPath, 'utf8')), manifest.programId);
  assertEqual(
    `Anchor.toml [programs.${cluster}].receipt`,
    extractAnchorProgramId(readFileSync(anchorTomlPath, 'utf8'), cluster),
    manifest.programId,
  );

  if (cluster === 'devnet') {
    if (!DEFAULT_CONFIG.receiptProgramId) fail('DEFAULT_CONFIG.receiptProgramId must be set for devnet');
    if (!DEFAULT_CONFIG.receiptIdlHashMode) fail('DEFAULT_CONFIG.receiptIdlHashMode must be set for devnet');
    if (!DEFAULT_CONFIG.receiptIdlHash) fail('DEFAULT_CONFIG.receiptIdlHash must be set for devnet');
    if (!DEFAULT_CONFIG.receiptIdlPath) fail('DEFAULT_CONFIG.receiptIdlPath must be set for devnet');
    assertEqual('defaultConfig.receiptProgramId', DEFAULT_CONFIG.receiptProgramId, manifest.programId);
    assertEqual('defaultConfig.receiptIdlHashMode', DEFAULT_CONFIG.receiptIdlHashMode, manifest.idlHashMode);
    assertEqual('defaultConfig.receiptIdlHash', DEFAULT_CONFIG.receiptIdlHash, manifest.idlHash);
    assertEqual('defaultConfig.receiptIdlPath', DEFAULT_CONFIG.receiptIdlPath, manifest.idlPath);
  }

  const resolved = resolveReceiptRuntimeIdentity(
    { ...DEFAULT_CONFIG, cluster },
    manifestPath ? { RECEIPT_MANIFEST_PATH: selectedManifestPath } : {},
  );
  if (!resolved) fail(`Resolver returned null for ${cluster} identity`);

  assertEqual('programId', resolved.programId.toBase58(), manifest.programId);
  assertEqual('idlHashMode', resolved.idlHashMode, manifest.idlHashMode);
  assertEqual('idlHash', resolved.idlHash, manifest.idlHash);
  assertEqual('idlPath', resolved.idlPath, manifest.idlPath);

  const idlAbsPath = resolve(root, manifest.idlPath);
  if (!existsSync(idlAbsPath)) {
    fail('IDL artifact path does not exist', { idlPath: manifest.idlPath, idlAbsPath });
  }

  const connection = new Connection(
    rpcUrl ?? (cluster === 'mainnet' ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com'),
    'confirmed',
  );
  const onChain = await verifyReceiptProgramOnChain(connection, resolved);
  if (manifest.observedUpgradeAuthority && onChain.upgradeAuthority !== manifest.observedUpgradeAuthority) {
    fail('Manifest observedUpgradeAuthority does not match on-chain state', {
      expected: manifest.observedUpgradeAuthority,
      actual: onChain.upgradeAuthority,
    });
  }

  return {
    cluster,
    manifestPath: selectedManifestPath,
    programId: resolved.programId.toBase58(),
    idlHashMode: resolved.idlHashMode,
    idlHash: resolved.idlHash,
    idlPath: manifest.idlPath,
    observedUpgradeAuthority: onChain.upgradeAuthority,
    programBinaryPath: manifest.programBinaryPath,
    programBinarySha256: manifest.programBinarySha256,
    deployedSlot: manifest.deployedSlot,
  };
}
