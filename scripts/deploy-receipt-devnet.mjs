#!/usr/bin/env node
import { relative, resolve } from 'node:path';
import {
  DEPLOYMENT_DIRS,
  IDL_HASH_MODE,
  IDL_OUTPUT_PATHS,
  MANIFEST_PATHS,
  REPO_ROOT,
  TOOLCHAIN,
  TARGET_IDL_PATH,
  assertBuiltIdentity,
  assertPinnedToolchain,
  buildReceipt,
  computeIdlHash,
  copyFileAtomic,
  getGitCommit,
  getWalletPubkey,
  parseArgs,
  readProgramShow,
  runProgramDeploy,
  runPassthrough,
  writeJsonAtomic,
} from './receipt-release-lib.mjs';

function fail(message) {
  throw new Error(message);
}

function getDefaultWalletPath() {
  const home = process.env.HOME;
  if (!home) fail('HOME must be set to resolve default wallet path');
  return resolve(home, '.config/solana/id.json');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rpcUrl =
    typeof args['rpc-url'] === 'string' ? args['rpc-url'] : process.env.SOLANA_RPC_URL ?? process.env.RPC_URL ?? 'https://api.devnet.solana.com';
  const walletPath =
    typeof args.wallet === 'string' ? args.wallet : process.env.ANCHOR_WALLET ?? process.env.SOLANA_WALLET ?? getDefaultWalletPath();
  const programKeypairPath =
    typeof args['program-keypair'] === 'string' ? args['program-keypair'] : process.env.RECEIPT_PROGRAM_KEYPAIR;
  if (!programKeypairPath) {
    fail('Devnet deploy requires --program-keypair or RECEIPT_PROGRAM_KEYPAIR');
  }

  const expectedUpgradeAuthority =
    typeof args['expected-upgrade-authority'] === 'string'
      ? args['expected-upgrade-authority']
      : process.env.EXPECTED_UPGRADE_AUTHORITY;

  assertPinnedToolchain();
  console.log('[m15] anchor build');
  buildReceipt();

  const programId = assertBuiltIdentity('devnet', programKeypairPath);
  console.log(`[m15] deploying fixed program id: ${programId}`);
  const deploy = runProgramDeploy({
    binaryPath: resolve(REPO_ROOT, 'target/deploy/receipt.so'),
    programKeypairPath,
    rpcUrl,
    walletPath,
  });

  if (deploy.programId && deploy.programId !== programId) {
    fail(`solana program deploy returned unexpected program id ${deploy.programId} (expected ${programId})`);
  }

  copyFileAtomic(TARGET_IDL_PATH, IDL_OUTPUT_PATHS.devnet);
  const idlHash = computeIdlHash(IDL_OUTPUT_PATHS.devnet);
  const walletPubkey = getWalletPubkey(walletPath);
  const gitCommit = getGitCommit();
  const programShow = readProgramShow(programId, rpcUrl);
  const deployedSlot =
    typeof programShow.lastDeploySlot === 'number'
      ? programShow.lastDeploySlot
      : typeof programShow.lastDeployedSlot === 'number'
        ? programShow.lastDeployedSlot
        : undefined;

  writeJsonAtomic(MANIFEST_PATHS.devnet, {
    cluster: 'devnet',
    programId,
    idlPath: relative(REPO_ROOT, IDL_OUTPUT_PATHS.devnet).replace(/\\/g, '/'),
    idlHashMode: IDL_HASH_MODE,
    idlHash,
    deployedAt: new Date().toISOString(),
    gitCommit,
    deployerPubkey: walletPubkey,
    ...(expectedUpgradeAuthority ? { expectedUpgradeAuthority } : {}),
    ...(expectedUpgradeAuthority ? { observedUpgradeAuthority: expectedUpgradeAuthority } : {}),
    ...(typeof deploy.deploySignature === 'string' ? { deploySignature: deploy.deploySignature } : {}),
    ...(typeof deployedSlot === 'number' ? { deployedSlot } : {}),
    toolchain: {
      anchorVersion: TOOLCHAIN.anchorVersion,
      solanaVersion: TOOLCHAIN.solanaVersion,
    },
  });

  console.log(`[m15] manifest updated: ${MANIFEST_PATHS.devnet}`);
  console.log('[m15] running consistency guard');
  console.log(`[m15] artifacts written under ${DEPLOYMENT_DIRS.devnet}`);
  runPassthrough('node', ['scripts/check-devnet-receipt-consistency.mjs']);
}

try {
  main();
} catch (error) {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`[m15] deploy failed: ${msg}`);
  process.exit(1);
}
