import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from '@clmm-autopilot/core';
import { resolveReceiptRuntimeIdentity, type ReceiptDeploymentManifest } from './receiptIdentity';

function fail(message: string, debug?: unknown): never {
  const detail = debug ? `\n${JSON.stringify(debug, null, 2)}` : '';
  throw new Error(`${message}${detail}`);
}

function assertEqual(name: string, actual: string, expected: string): void {
  if (actual !== expected) {
    fail(`${name} mismatch`, { actual, expected });
  }
}

function assertManifestStringField(manifest: Record<string, unknown>, field: string): string {
  const value = manifest[field];
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`Manifest field missing/invalid: ${field}`, { value });
  }
  if (value.trim().toLowerCase() === 'unknown') {
    fail(`Manifest field cannot be placeholder 'unknown': ${field}`, { value });
  }
  return value.trim();
}

function extractDeclareId(source: string): string {
  const match = source.match(/declare_id!\("([1-9A-HJ-NP-Za-km-z]{32,44})"\);/);
  if (!match?.[1]) {
    fail('Unable to parse programs/receipt/src/lib.rs declare_id!()');
  }
  return match[1];
}

function extractAnchorDevnetProgramId(source: string): string {
  const match = source.match(/\[programs\.devnet\][\s\S]*?receipt\s*=\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/);
  if (!match?.[1]) {
    fail('Unable to parse Anchor.toml [programs.devnet].receipt');
  }
  return match[1];
}

function assertDeployedMetadata(manifest: Record<string, unknown>): void {
  const deployedAt = assertManifestStringField(manifest, 'deployedAt');
  const parsed = Date.parse(deployedAt);
  if (!Number.isFinite(parsed)) {
    fail('Manifest deployedAt is not a valid ISO timestamp', { deployedAt });
  }
  if (new Date(parsed).getUTCFullYear() < 2020) {
    fail('Manifest deployedAt is not plausible for a real deployment', { deployedAt });
  }

  const gitCommit = assertManifestStringField(manifest, 'gitCommit');
  if (!/^[a-f0-9]{7,40}$/i.test(gitCommit)) {
    fail('Manifest gitCommit must be a 7-40 char git hash', { gitCommit });
  }

  const deployerPubkey = manifest.deployerPubkey;
  if (deployerPubkey !== undefined) {
    if (typeof deployerPubkey !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(deployerPubkey)) {
      fail('Manifest deployerPubkey must be a base58 public key when provided', { deployerPubkey });
    }
  }
}

function main(): void {
  const srcDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(srcDir, '../../..');
  const manifestPath = resolve(repoRoot, 'deployments/devnet/receipt.json');
  const libPath = resolve(repoRoot, 'programs/receipt/src/lib.rs');
  const anchorTomlPath = resolve(repoRoot, 'Anchor.toml');

  const manifestRaw = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  assertDeployedMetadata(manifestRaw);
  const manifest = manifestRaw as ReceiptDeploymentManifest;
  assertEqual('programs/receipt/src/lib.rs declare_id!', extractDeclareId(readFileSync(libPath, 'utf8')), manifest.programId);
  assertEqual(
    'Anchor.toml [programs.devnet].receipt',
    extractAnchorDevnetProgramId(readFileSync(anchorTomlPath, 'utf8')),
    manifest.programId,
  );
  if (!DEFAULT_CONFIG.receiptProgramId) fail('DEFAULT_CONFIG.receiptProgramId must be set for devnet');
  if (!DEFAULT_CONFIG.receiptIdlHashMode) fail('DEFAULT_CONFIG.receiptIdlHashMode must be set for devnet');
  if (!DEFAULT_CONFIG.receiptIdlHash) fail('DEFAULT_CONFIG.receiptIdlHash must be set for devnet');
  if (!DEFAULT_CONFIG.receiptIdlPath) fail('DEFAULT_CONFIG.receiptIdlPath must be set for devnet');

  assertEqual('defaultConfig.receiptProgramId', DEFAULT_CONFIG.receiptProgramId, manifest.programId);
  assertEqual('defaultConfig.receiptIdlHashMode', DEFAULT_CONFIG.receiptIdlHashMode, manifest.idlHashMode);
  assertEqual('defaultConfig.receiptIdlHash', DEFAULT_CONFIG.receiptIdlHash, manifest.idlHash);
  assertEqual('defaultConfig.receiptIdlPath', DEFAULT_CONFIG.receiptIdlPath, manifest.idlPath);

  const resolved = resolveReceiptRuntimeIdentity({ ...DEFAULT_CONFIG, cluster: 'devnet' });
  if (!resolved) fail('Resolver returned null for devnet identity');

  assertEqual('programId', resolved.programId.toBase58(), manifest.programId);
  assertEqual('idlHashMode', resolved.idlHashMode, manifest.idlHashMode);
  assertEqual('idlHash', resolved.idlHash, manifest.idlHash);
  assertEqual('idlPath', resolved.idlPath, manifest.idlPath);

  const idlAbsPath = resolve(repoRoot, manifest.idlPath);
  if (!existsSync(idlAbsPath)) {
    fail('IDL artifact path does not exist', { idlPath: manifest.idlPath, idlAbsPath });
  }

  console.log(
    JSON.stringify({
      ok: true,
      programId: resolved.programId.toBase58(),
      idlHashMode: resolved.idlHashMode,
      idlHash: resolved.idlHash,
      idlPath: manifest.idlPath,
    }),
  );
}

main();
