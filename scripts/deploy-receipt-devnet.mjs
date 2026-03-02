#!/usr/bin/env node
import { execSync, spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROGRAM_NAME = 'receipt';
const IDL_HASH_MODE = 'full-v1';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const targetIdl = resolve(repoRoot, 'target/idl/receipt.json');
const deployedIdl = resolve(repoRoot, 'deployments/devnet/receipt.idl.json');
const manifestPath = resolve(repoRoot, 'deployments/devnet/receipt.json');
const devnetIdlPath = 'deployments/devnet/receipt.idl.json';

function run(cmd, opts = {}) {
  const merged = {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe'],
    ...opts,
  };
  return execSync(cmd, merged).trim();
}

function runPassthrough(cmd, args) {
  const out = spawnSync(cmd, args, { cwd: repoRoot, stdio: 'inherit' });
  if (out.status !== 0) {
    process.exit(out.status ?? 1);
  }
}

function parseProgramIdFromDeployOutput(output) {
  const direct = output.match(/Program Id:\s*([1-9A-HJ-NP-Za-km-z]{32,44})/i);
  if (direct?.[1]) return direct[1];
  const fallback = output.match(/([1-9A-HJ-NP-Za-km-z]{32,44})/g);
  if (fallback && fallback.length > 0) return fallback[fallback.length - 1];
  throw new Error(`Unable to parse program id from anchor deploy output:\n${output}`);
}

function computeIdlHash(idlPath) {
  const out = execSync(`pnpm -C packages/solana exec vite-node src/receiptHash.cli.ts ${idlPath}`, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe'],
  }).trim();
  if (!/^[a-f0-9]{64}$/i.test(out)) {
    throw new Error(`Invalid IDL hash output: ${out}`);
  }
  return out.toLowerCase();
}

function writeManifestAtomic(payload) {
  const tmp = `${manifestPath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  renameSync(tmp, manifestPath);
}

function replaceOrThrow(source, pattern, replacement, context) {
  if (!pattern.test(source)) {
    throw new Error(`Unable to update ${context}; pattern not found`);
  }
  return source.replace(pattern, replacement);
}

function syncAnchorIds(programId) {
  const libPath = resolve(repoRoot, 'programs/receipt/src/lib.rs');
  const anchorTomlPath = resolve(repoRoot, 'Anchor.toml');

  const lib = replaceOrThrow(
    readFileSync(libPath, 'utf8'),
    /declare_id!\("[1-9A-HJ-NP-Za-km-z]{32,44}"\);/,
    `declare_id!("${programId}");`,
    `${PROGRAM_NAME} declare_id!`,
  );
  writeFileSync(libPath, lib, 'utf8');

  const anchorToml = replaceOrThrow(
    readFileSync(anchorTomlPath, 'utf8'),
    /(\[programs\.devnet\][\s\S]*?receipt\s*=\s*")[1-9A-HJ-NP-Za-km-z]{32,44}(")/,
    `$1${programId}$2`,
    'Anchor.toml [programs.devnet].receipt',
  );
  writeFileSync(anchorTomlPath, anchorToml, 'utf8');
}

function syncCoreDevnetFallback(programId, idlHash) {
  const coreConfigPath = resolve(repoRoot, 'packages/core/src/config.ts');
  let configSrc = readFileSync(coreConfigPath, 'utf8');
  configSrc = replaceOrThrow(
    configSrc,
    /const DEVNET_RECEIPT_PROGRAM_ID = '[1-9A-HJ-NP-Za-km-z]{32,44}';/,
    `const DEVNET_RECEIPT_PROGRAM_ID = '${programId}';`,
    'core DEVNET_RECEIPT_PROGRAM_ID',
  );
  configSrc = replaceOrThrow(
    configSrc,
    /const DEVNET_RECEIPT_IDL_HASH = '[a-f0-9]{64}';/i,
    `const DEVNET_RECEIPT_IDL_HASH = '${idlHash}';`,
    'core DEVNET_RECEIPT_IDL_HASH',
  );
  configSrc = replaceOrThrow(
    configSrc,
    /const DEVNET_RECEIPT_IDL_PATH = '[^']+';/,
    `const DEVNET_RECEIPT_IDL_PATH = '${devnetIdlPath}';`,
    'core DEVNET_RECEIPT_IDL_PATH',
  );
  writeFileSync(coreConfigPath, configSrc, 'utf8');
}

try {
  console.log('[m15] anchor build');
  runPassthrough('anchor', ['build']);

  console.log('[m15] anchor deploy --provider.cluster devnet');
  const deployOutput = run('anchor deploy --provider.cluster devnet');
  const programId = parseProgramIdFromDeployOutput(deployOutput);
  console.log(`[m15] deployed program id: ${programId}`);

  copyFileSync(targetIdl, deployedIdl);
  const idlHash = computeIdlHash(deployedIdl);

  const commit = run('git rev-parse HEAD');
  const deployerPubkey = run('solana address');

  const manifest = {
    cluster: 'devnet',
    programId,
    idlPath: devnetIdlPath,
    idlHashMode: IDL_HASH_MODE,
    idlHash,
    deployedAt: new Date().toISOString(),
    gitCommit: commit,
    deployerPubkey,
  };

  writeManifestAtomic(manifest);
  console.log(`[m15] manifest updated: ${manifestPath}`);

  syncAnchorIds(programId);
  syncCoreDevnetFallback(programId, idlHash);
  console.log('[m15] synced declare_id!, Anchor.toml devnet entry, and core devnet fallback identity');

  console.log('[m15] solana program show verification');
  runPassthrough('solana', ['program', 'show', programId, '--url', 'devnet']);

  console.log('[m15] running consistency guard');
  runPassthrough('node', ['scripts/check-devnet-receipt-consistency.mjs']);
} catch (error) {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`[m15] deploy failed: ${msg}`);
  process.exit(1);
}
