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

function main(): void {
  const srcDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(srcDir, '../../..');
  const manifestPath = resolve(repoRoot, 'deployments/devnet/receipt.json');

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ReceiptDeploymentManifest;
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
