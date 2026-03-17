#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import {
  MANIFEST_PATHS,
  REPO_ROOT,
  TOOLCHAIN,
  assertPinnedToolchain,
  computeFileSha256,
  parseArgs,
  runPassthrough,
  runSolanaVerifyHashes,
} from './receipt-release-lib.mjs';

function fail(message, debug) {
  const detail = debug ? `\n${JSON.stringify(debug, null, 2)}` : '';
  throw new Error(`${message}${detail}`);
}

function assertStringField(source, field) {
  const value = source[field];
  if (typeof value !== 'string' || value.trim() === '' || value.trim().toLowerCase() === 'unknown') {
    fail(`Manifest field missing/invalid: ${field}`, { value });
  }
  return value.trim();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rpcUrl = typeof args['rpc-url'] === 'string' ? args['rpc-url'] : process.env.SOLANA_RPC_URL ?? process.env.RPC_URL;
  if (!rpcUrl) {
    fail('Mainnet consistency check requires --rpc-url or SOLANA_RPC_URL/RPC_URL');
  }

  assertPinnedToolchain({ requireSolanaVerify: true });

  const manifestPath =
    typeof args['manifest-path'] === 'string' ? args['manifest-path'] : process.env.RECEIPT_MANIFEST_PATH ?? MANIFEST_PATHS.mainnet;
  if (!existsSync(manifestPath)) {
    fail('Mainnet manifest not found', { manifestPath });
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.cluster !== 'mainnet') {
    fail("Manifest cluster must be 'mainnet'", { cluster: manifest.cluster });
  }

  const programId = assertStringField(manifest, 'programId');
  const programBinaryPath = assertStringField(manifest, 'programBinaryPath');
  const programBinarySha256 = assertStringField(manifest, 'programBinarySha256').toLowerCase();
  const binaryPath = programBinaryPath.startsWith('/') ? programBinaryPath : `${REPO_ROOT}/${programBinaryPath}`;
  if (!existsSync(binaryPath)) {
    fail('Manifest programBinaryPath does not exist', { programBinaryPath, binaryPath });
  }
  const actualBinaryHash = computeFileSha256(binaryPath);
  if (actualBinaryHash !== programBinarySha256) {
    fail('Manifest programBinarySha256 does not match binary artifact', {
      expected: programBinarySha256,
      actual: actualBinaryHash,
    });
  }

  const toolchain = manifest.toolchain;
  if (!toolchain || typeof toolchain !== 'object') {
    fail('Manifest toolchain metadata missing');
  }
  if (toolchain.anchorVersion !== TOOLCHAIN.anchorVersion || toolchain.solanaVersion !== TOOLCHAIN.solanaVersion) {
    fail('Manifest toolchain does not match pinned Anchor/Solana versions', { toolchain, expected: TOOLCHAIN });
  }
  if (toolchain.solanaVerifyVersion !== TOOLCHAIN.solanaVerifyVersion) {
    fail('Manifest toolchain does not match pinned solana-verify version', { toolchain, expected: TOOLCHAIN });
  }

  const verifiedBuild = manifest.verifiedBuild;
  if (!verifiedBuild || typeof verifiedBuild !== 'object') {
    fail('Manifest verifiedBuild metadata missing');
  }
  const evidencePath = assertStringField(verifiedBuild, 'evidencePath');
  const absoluteEvidencePath = evidencePath.startsWith('/') ? evidencePath : `${REPO_ROOT}/${evidencePath}`;
  if (!existsSync(absoluteEvidencePath)) {
    fail('Manifest verifiedBuild evidencePath does not exist', { evidencePath, absoluteEvidencePath });
  }

  const verifyEvidence = runSolanaVerifyHashes({
    binaryPath,
    rpcUrl,
    programId,
  });
  if (verifyEvidence.executableHash !== verifiedBuild.executableHash || verifyEvidence.programHash !== verifiedBuild.programHash) {
    fail('solana-verify output does not match manifest verifiedBuild metadata', {
      expected: verifiedBuild,
      actual: verifyEvidence,
    });
  }

  runPassthrough('pnpm', [
    '-C',
    'packages/solana',
    'exec',
    'vite-node',
    'src/checkReceiptConsistency.cli.ts',
    '--cluster',
    'mainnet',
    '--rpc-url',
    rpcUrl,
    '--manifest-path',
    manifestPath,
  ]);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[m20] consistency check failed: ${message}`);
  process.exit(1);
}
