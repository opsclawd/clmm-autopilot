#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROGRAM_NAME = 'receipt';
export const IDL_HASH_MODE = 'full-v1';
export const TOOLCHAIN = {
  anchorVersion: '0.32.1',
  solanaVersion: '2.3.0',
  solanaVerifyVersion: '0.4.12',
};

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '..');
export const PROGRAM_DIR = resolve(REPO_ROOT, 'programs/receipt');
export const TARGET_IDL_PATH = resolve(REPO_ROOT, 'target/idl/receipt.json');
export const TARGET_BINARY_PATH = resolve(REPO_ROOT, 'target/deploy/receipt.so');
export const VERIFIABLE_BINARY_PATH = resolve(REPO_ROOT, 'target/verifiable/receipt.so');
export const ANCHOR_TOML_PATH = resolve(REPO_ROOT, 'Anchor.toml');
export const LIB_RS_PATH = resolve(REPO_ROOT, 'programs/receipt/src/lib.rs');
export const DEPLOYMENT_DIRS = {
  devnet: resolve(REPO_ROOT, 'deployments/devnet'),
  mainnet: resolve(REPO_ROOT, 'deployments/mainnet'),
};
export const MANIFEST_PATHS = {
  devnet: resolve(DEPLOYMENT_DIRS.devnet, 'receipt.json'),
  mainnet: resolve(DEPLOYMENT_DIRS.mainnet, 'receipt.json'),
};
export const IDL_OUTPUT_PATHS = {
  devnet: resolve(DEPLOYMENT_DIRS.devnet, 'receipt.idl.json'),
  mainnet: resolve(DEPLOYMENT_DIRS.mainnet, 'receipt.idl.json'),
};
export const BINARY_OUTPUT_PATHS = {
  mainnet: resolve(DEPLOYMENT_DIRS.mainnet, 'receipt.so'),
};
export const PROVENANCE_OUTPUT_PATHS = {
  mainnet: resolve(DEPLOYMENT_DIRS.mainnet, 'receipt.provenance.json'),
};
export const VERIFY_EVIDENCE_PATHS = {
  mainnet: resolve(DEPLOYMENT_DIRS.mainnet, 'receipt.verify.json'),
};

function normalizeError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function run(cmd, args = [], opts = {}) {
  try {
    return execFileSync(cmd, args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    }).trim();
  } catch (error) {
    const detail =
      error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string'
        ? error.stderr.trim()
        : normalizeError(error);
    throw new Error(`${cmd} ${args.join(' ')} failed: ${detail}`);
  }
}

export function runPassthrough(cmd, args = [], opts = {}) {
  const out = spawnSync(cmd, args, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    ...opts,
  });
  if (out.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited with status ${out.status ?? 1}`);
  }
}

export function spawnCaptured(cmd, args = [], opts = {}) {
  return spawnSync(cmd, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...opts,
  });
}

export function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true });
}

export function writeJsonAtomic(targetPath, payload) {
  ensureDir(dirname(targetPath));
  const tmp = `${targetPath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  renameSync(tmp, targetPath);
}

export function copyFileAtomic(sourcePath, targetPath) {
  ensureDir(dirname(targetPath));
  const tmp = `${targetPath}.tmp`;
  copyFileSync(sourcePath, tmp);
  renameSync(tmp, targetPath);
}

export function computeFileSha256(targetPath) {
  return createHash('sha256').update(readFileSync(targetPath)).digest('hex');
}

export function computeIdlHash(idlPath) {
  const out = run('pnpm', ['-C', 'packages/solana', 'exec', 'vite-node', 'src/receiptHash.cli.ts', idlPath], {
    cwd: REPO_ROOT,
  });
  if (!/^[a-f0-9]{64}$/i.test(out)) {
    throw new Error(`Invalid IDL hash output: ${out}`);
  }
  return out.toLowerCase();
}

export function readToolVersion(cmd, args = ['--version']) {
  return run(cmd, args).split(/\r?\n/)[0].trim();
}

export function extractVersionToken(toolName, versionOutput) {
  const match = versionOutput.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b/);
  if (!match?.[1]) {
    throw new Error(`Unable to parse ${toolName} version from: ${versionOutput}`);
  }
  return match[1];
}

export function assertExactToolVersion(toolName, versionOutput, expectedVersion) {
  const actualVersion = extractVersionToken(toolName, versionOutput);
  if (actualVersion !== expectedVersion) {
    throw new Error(`${toolName} version mismatch: ${versionOutput} (expected ${expectedVersion})`);
  }
  return actualVersion;
}

export function assertPinnedToolchain({ requireSolanaVerify = false } = {}) {
  const anchorVersion = readToolVersion('anchor', ['--version']);
  assertExactToolVersion('anchor CLI', anchorVersion, TOOLCHAIN.anchorVersion);

  const solanaVersion = readToolVersion('solana', ['--version']);
  assertExactToolVersion('solana CLI', solanaVersion, TOOLCHAIN.solanaVersion);

  if (!requireSolanaVerify) return TOOLCHAIN;

  const solanaVerifyVersion = readToolVersion('solana-verify', ['--version']);
  assertExactToolVersion('solana-verify', solanaVerifyVersion, TOOLCHAIN.solanaVerifyVersion);

  return TOOLCHAIN;
}

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) continue;
    const key = raw.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

export function extractDeclareId(source) {
  const match = source.match(/declare_id!\("([1-9A-HJ-NP-Za-km-z]{32,44})"\);/);
  if (!match?.[1]) {
    throw new Error('Unable to parse programs/receipt/src/lib.rs declare_id!()');
  }
  return match[1];
}

export function extractAnchorProgramId(source, cluster) {
  const match = source.match(
    new RegExp(`\\[programs\\.${cluster}\\][\\s\\S]*?receipt\\s*=\\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"`),
  );
  if (!match?.[1]) {
    throw new Error(`Unable to parse Anchor.toml [programs.${cluster}].receipt`);
  }
  return match[1];
}

export function readDeclaredProgramId() {
  return extractDeclareId(readFileSync(LIB_RS_PATH, 'utf8'));
}

export function readAnchorProgramId(cluster) {
  return extractAnchorProgramId(readFileSync(ANCHOR_TOML_PATH, 'utf8'), cluster);
}

export function readProgramKeypairPubkey(keypairPath) {
  return run('solana', ['address', '-k', keypairPath]);
}

export function readTargetIdlAddress() {
  if (!existsSync(TARGET_IDL_PATH)) {
    throw new Error(`IDL artifact missing: ${TARGET_IDL_PATH}`);
  }
  const idl = JSON.parse(readFileSync(TARGET_IDL_PATH, 'utf8'));
  if (typeof idl.address !== 'string' || idl.address.trim() === '') {
    throw new Error(`IDL artifact missing address field: ${TARGET_IDL_PATH}`);
  }
  return idl.address.trim();
}

export function assertStaticIdentity(cluster, programKeypairPath) {
  const declareId = readDeclaredProgramId();
  const anchorProgramId = readAnchorProgramId(cluster);
  const keypairPubkey = readProgramKeypairPubkey(programKeypairPath);
  if (declareId !== anchorProgramId || declareId !== keypairPubkey) {
    throw new Error(
      `Fixed program identity mismatch for ${cluster}: declare_id=${declareId} anchor=${anchorProgramId} keypair=${keypairPubkey}`,
    );
  }
  return declareId;
}

export function assertBuiltIdentity(cluster, programKeypairPath) {
  const programId = assertStaticIdentity(cluster, programKeypairPath);
  const idlAddress = readTargetIdlAddress();
  if (idlAddress !== programId) {
    throw new Error(`Built IDL address mismatch: ${idlAddress} (expected ${programId})`);
  }
  return programId;
}

export function getWalletPubkey(walletPath) {
  return run('solana', ['address', '-k', walletPath]);
}

export function getGitCommit() {
  return run('git', ['rev-parse', 'HEAD']);
}

export function getExpectedBuiltBinaryPaths({ verifiable = false } = {}) {
  return verifiable ? [VERIFIABLE_BINARY_PATH] : [TARGET_BINARY_PATH];
}

export function resolveBuiltBinaryPath({ verifiable = false } = {}) {
  for (const candidate of getExpectedBuiltBinaryPaths({ verifiable })) {
    if (existsSync(candidate)) return candidate;
  }

  const expected = getExpectedBuiltBinaryPaths({ verifiable });
  throw new Error(`Program binary missing; checked: ${expected.join(', ')}`);
}

export function getBuiltProgramArtifactSize(opts = {}) {
  const binaryPath = resolveBuiltBinaryPath(opts);
  return statSync(binaryPath).size;
}

export function parseIntegerFromOutput(output, label) {
  const match = output.replace(/,/g, '').match(/(\d+)/);
  if (!match?.[1]) {
    throw new Error(`Unable to parse ${label}: ${output}`);
  }
  return Number(match[1]);
}

export function estimateRentLamports(byteLength, rpcUrl) {
  const out = run('solana', ['rent', String(byteLength), '--lamports', '--url', rpcUrl]);
  return parseIntegerFromOutput(out, 'rent-exempt minimum');
}

export function readBalanceLamports(walletPath, rpcUrl) {
  const out = run('solana', ['balance', '-k', walletPath, '--lamports', '--url', rpcUrl]);
  return parseIntegerFromOutput(out, 'wallet balance');
}

export function parseDeployOutput(output) {
  try {
    const parsed = JSON.parse(output);
    if (parsed && typeof parsed === 'object') {
      return {
        programId:
          typeof parsed.programId === 'string'
            ? parsed.programId
            : typeof parsed.program_id === 'string'
              ? parsed.program_id
              : undefined,
        deploySignature:
          typeof parsed.signature === 'string'
            ? parsed.signature
            : typeof parsed.txSignature === 'string'
              ? parsed.txSignature
              : undefined,
      };
    }
  } catch {
    // fall through to text parsing
  }

  const programMatch = output.match(/Program Id:\s*([1-9A-HJ-NP-Za-km-z]{32,44})/i);
  const sigMatch =
    output.match(/Signature:\s*([1-9A-HJ-NP-Za-km-z]{32,88})/i) ||
    output.match(/transaction signature[:\s]+([1-9A-HJ-NP-Za-km-z]{32,88})/i);
  return {
    programId: programMatch?.[1],
    deploySignature: sigMatch?.[1],
  };
}

export function runProgramDeploy({ binaryPath, programKeypairPath, rpcUrl, walletPath }) {
  const result = spawnCaptured(
    'solana',
    [
      'program',
      'deploy',
      binaryPath,
      '--program-id',
      programKeypairPath,
      '--url',
      rpcUrl,
      '--keypair',
      walletPath,
      '--output',
      'json-compact',
    ],
    { cwd: REPO_ROOT },
  );
  const stdout = result.stdout?.trim() ?? '';
  const stderr = result.stderr?.trim() ?? '';
  if (result.status !== 0) {
    throw new Error(`solana program deploy failed: ${stderr || stdout || `exit ${result.status}`}`);
  }
  return { ...parseDeployOutput(stdout), stdout, stderr };
}

export function buildSetUpgradeAuthorityArgs({ programId, rpcUrl, walletPath, expectedUpgradeAuthority }) {
  return [
    'program',
    'set-upgrade-authority',
    programId,
    '--new-upgrade-authority',
    expectedUpgradeAuthority,
    '--skip-new-upgrade-authority-signer-check',
    '--url',
    rpcUrl,
    '--keypair',
    walletPath,
    '--output',
    'json-compact',
  ];
}

export function runSetUpgradeAuthority({ programId, rpcUrl, walletPath, expectedUpgradeAuthority }) {
  const result = spawnCaptured(
    'solana',
    buildSetUpgradeAuthorityArgs({ programId, rpcUrl, walletPath, expectedUpgradeAuthority }),
    { cwd: REPO_ROOT },
  );
  const stdout = result.stdout?.trim() ?? '';
  const stderr = result.stderr?.trim() ?? '';
  if (result.status !== 0) {
    throw new Error(`solana program set-upgrade-authority failed: ${stderr || stdout || `exit ${result.status}`}`);
  }
  return { stdout, stderr };
}

export function readProgramShow(programId, rpcUrl) {
  const output = run('solana', ['program', 'show', programId, '--url', rpcUrl, '--output', 'json-compact']);
  try {
    return JSON.parse(output);
  } catch {
    return { raw: output };
  }
}

function findObjectField(object, candidates) {
  if (!object || typeof object !== 'object') return undefined;
  for (const name of candidates) {
    const value = object[name];
    if (value !== undefined) return value;
  }
  return undefined;
}

export function extractProgramShowSlot(programShow) {
  const raw = findObjectField(programShow, ['lastDeploySlot', 'lastDeployedSlot', 'slot']);
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === 'string' && raw.trim() !== '') return Number(raw.trim());
  throw new Error(`Unable to determine deployed slot from solana program show output: ${JSON.stringify(programShow)}`);
}

export function runSolanaVerifyHashes({ binaryPath, rpcUrl, programId, evidencePath }) {
  const version = readToolVersion('solana-verify', ['--version']);
  const executableHash = run('solana-verify', ['get-executable-hash', binaryPath]);
  const programHash = run('solana-verify', ['get-program-hash', '-u', rpcUrl, programId]);
  const evidence = {
    tool: 'solana-verify',
    version,
    verifiedAt: new Date().toISOString(),
    executableHashCommand: ['solana-verify', 'get-executable-hash', binaryPath],
    programHashCommand: ['solana-verify', 'get-program-hash', '-u', rpcUrl, programId],
    executableHash,
    programHash,
  };
  if (evidencePath) {
    writeJsonAtomic(evidencePath, evidence);
  }
  if (executableHash !== programHash) {
    throw new Error(`Verified-build hash mismatch: executable=${executableHash} onchain=${programHash}`);
  }
  return evidence;
}

export function buildReceipt({ verifiable = false } = {}) {
  if (verifiable) {
    runPassthrough('anchor', ['build', '--verifiable'], { cwd: PROGRAM_DIR });
    return;
  }
  runPassthrough('anchor', ['build'], { cwd: REPO_ROOT });
}
