#!/usr/bin/env node
import { relative, resolve } from 'node:path';
import {
  DEPLOYMENT_DIRS,
  IDL_HASH_MODE,
  REPO_ROOT,
  TARGET_IDL_PATH,
  TOOLCHAIN,
  assertBuiltIdentity,
  assertPinnedToolchain,
  buildReceipt,
  computeFileSha256,
  computeIdlHash,
  copyFileAtomic,
  estimateRentLamports,
  extractProgramShowSlot,
  getBuiltProgramArtifactSize,
  getGitCommit,
  getWalletPubkey,
  parseArgs,
  readBalanceLamports,
  readProgramShow,
  resolveBuiltBinaryPath,
  runProgramDeploy,
  runSetUpgradeAuthority,
  runSolanaVerifyHashes,
  runPassthrough,
  writeJsonAtomic,
} from './receipt-release-lib.mjs';

function fail(message, debug) {
  const detail = debug ? `\n${JSON.stringify(debug, null, 2)}` : '';
  throw new Error(`${message}${detail}`);
}

function getDefaultWalletPath() {
  const home = process.env.HOME;
  if (!home) fail('HOME must be set to resolve default wallet path');
  return resolve(home, '.config/solana/id.json');
}

function toRepoPath(targetPath) {
  return relative(REPO_ROOT, targetPath).replace(/\\/g, '/');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = args['dry-run'] === true;
  const rpcUrl = typeof args['rpc-url'] === 'string' ? args['rpc-url'] : process.env.SOLANA_RPC_URL ?? process.env.RPC_URL;
  if (!rpcUrl) {
    fail('Mainnet deploy requires --rpc-url or SOLANA_RPC_URL/RPC_URL');
  }
  const walletPath =
    typeof args.wallet === 'string' ? args.wallet : process.env.ANCHOR_WALLET ?? process.env.SOLANA_WALLET ?? getDefaultWalletPath();
  const programKeypairPath =
    typeof args['program-keypair'] === 'string' ? args['program-keypair'] : process.env.RECEIPT_PROGRAM_KEYPAIR;
  if (!programKeypairPath) {
    fail('Mainnet deploy requires --program-keypair or RECEIPT_PROGRAM_KEYPAIR');
  }
  const expectedUpgradeAuthority =
    typeof args['expected-upgrade-authority'] === 'string'
      ? args['expected-upgrade-authority']
      : process.env.EXPECTED_UPGRADE_AUTHORITY;
  if (!expectedUpgradeAuthority) {
    fail('Mainnet deploy requires --expected-upgrade-authority or EXPECTED_UPGRADE_AUTHORITY');
  }

  const outDir = typeof args['out-dir'] === 'string' ? resolve(REPO_ROOT, args['out-dir']) : DEPLOYMENT_DIRS.mainnet;
  const idlOutputPath = resolve(outDir, 'receipt.idl.json');
  const binaryOutputPath = resolve(outDir, 'receipt.so');
  const manifestPath = resolve(outDir, 'receipt.json');
  const provenancePath = resolve(outDir, 'receipt.provenance.json');
  const verifyEvidencePath = resolve(outDir, 'receipt.verify.json');

  assertPinnedToolchain({ requireSolanaVerify: true });
  console.log('[m20] anchor build --verifiable');
  buildReceipt({ verifiable: true });

  const programId = assertBuiltIdentity('mainnet', programKeypairPath);
  const builtBinaryPath = resolveBuiltBinaryPath({ verifiable: true });
  const binarySha256 = computeFileSha256(builtBinaryPath);
  const idlHash = computeIdlHash(TARGET_IDL_PATH);
  const binarySizeBytes = getBuiltProgramArtifactSize({ verifiable: true });
  const estimatedRentLamports = estimateRentLamports(binarySizeBytes, rpcUrl);
  const deployerBalanceLamports = readBalanceLamports(walletPath, rpcUrl);

  if (deployerBalanceLamports < estimatedRentLamports) {
    fail('Deployer balance is below the rent estimate for this program binary', {
      binarySizeBytes,
      estimatedRentLamports,
      deployerBalanceLamports,
    });
  }

  const walletPubkey = getWalletPubkey(walletPath);
  const gitCommit = getGitCommit();
  const manifestPreview = {
    cluster: 'mainnet',
    programId,
    idlPath: toRepoPath(idlOutputPath),
    idlHashMode: IDL_HASH_MODE,
    idlHash,
    programBinaryPath: toRepoPath(binaryOutputPath),
    programBinarySha256: binarySha256,
    deploySignature: '<post-deploy>',
    deployedSlot: '<post-deploy>',
    deployedAt: '<post-deploy>',
    gitCommit,
    deployerPubkey: walletPubkey,
    expectedUpgradeAuthority,
    observedUpgradeAuthority: expectedUpgradeAuthority,
    toolchain: {
      anchorVersion: TOOLCHAIN.anchorVersion,
      solanaVersion: TOOLCHAIN.solanaVersion,
      solanaVerifyVersion: TOOLCHAIN.solanaVerifyVersion,
    },
    verifiedBuild: {
      tool: 'solana-verify',
      version: TOOLCHAIN.solanaVerifyVersion,
      evidencePath: toRepoPath(verifyEvidencePath),
      executableHash: '<post-deploy>',
      programHash: '<post-deploy>',
    },
  };

  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          manifestPreview,
          preflight: {
            binarySizeBytes,
            estimatedRentLamports,
            deployerBalanceLamports,
          },
          commands: {
            build: ['anchor', 'build', '--verifiable'],
            deploy: ['solana', 'program', 'deploy', builtBinaryPath, '--program-id', programKeypairPath, '--url', rpcUrl, '--keypair', walletPath],
            transferAuthority: [
              'solana',
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
            ],
            verifyExecutableHash: ['solana-verify', 'get-executable-hash', binaryOutputPath],
            verifyProgramHash: ['solana-verify', 'get-program-hash', '-u', rpcUrl, programId],
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`[m20] deploying fixed program id: ${programId}`);
  const deploy = runProgramDeploy({
    binaryPath: builtBinaryPath,
    programKeypairPath,
    rpcUrl,
    walletPath,
  });
  if (deploy.programId && deploy.programId !== programId) {
    fail('solana program deploy returned unexpected program id', { expected: programId, actual: deploy.programId });
  }
  if (!deploy.deploySignature) {
    fail('Unable to parse deploy signature from solana program deploy output', { stdout: deploy.stdout });
  }

  console.log('[m20] transferring upgrade authority to multisig');
  runSetUpgradeAuthority({
    programId,
    rpcUrl,
    walletPath,
    expectedUpgradeAuthority,
  });

  copyFileAtomic(TARGET_IDL_PATH, idlOutputPath);
  copyFileAtomic(builtBinaryPath, binaryOutputPath);

  const verifiedBuild = runSolanaVerifyHashes({
    binaryPath: binaryOutputPath,
    rpcUrl,
    programId,
    evidencePath: verifyEvidencePath,
  });
  const programShow = readProgramShow(programId, rpcUrl);
  const deployedSlot = extractProgramShowSlot(programShow);

  writeJsonAtomic(provenancePath, {
    cluster: 'mainnet',
    programId,
    generatedAt: new Date().toISOString(),
    gitCommit,
    deployerPubkey: walletPubkey,
    binarySizeBytes,
    estimatedRentLamports,
    deployerBalanceLamports,
    idlHash,
    programBinarySha256: binarySha256,
    buildCommand: ['anchor', 'build', '--verifiable'],
    deployCommand: ['solana', 'program', 'deploy', builtBinaryPath, '--program-id', programKeypairPath, '--url', rpcUrl, '--keypair', walletPath],
    authorityTransferCommand: [
      'solana',
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
    ],
    toolchain: {
      anchorVersion: TOOLCHAIN.anchorVersion,
      solanaVersion: TOOLCHAIN.solanaVersion,
      solanaVerifyVersion: TOOLCHAIN.solanaVerifyVersion,
    },
  });

  writeJsonAtomic(manifestPath, {
    cluster: 'mainnet',
    programId,
    idlPath: toRepoPath(idlOutputPath),
    idlHashMode: IDL_HASH_MODE,
    idlHash,
    programBinaryPath: toRepoPath(binaryOutputPath),
    programBinarySha256: binarySha256,
    deployedAt: new Date().toISOString(),
    deployedSlot,
    deploySignature: deploy.deploySignature,
    gitCommit,
    deployerPubkey: walletPubkey,
    expectedUpgradeAuthority,
    observedUpgradeAuthority: expectedUpgradeAuthority,
    toolchain: {
      anchorVersion: TOOLCHAIN.anchorVersion,
      solanaVersion: TOOLCHAIN.solanaVersion,
      solanaVerifyVersion: TOOLCHAIN.solanaVerifyVersion,
    },
    verifiedBuild: {
      tool: 'solana-verify',
      version: TOOLCHAIN.solanaVerifyVersion,
      evidencePath: toRepoPath(verifyEvidencePath),
      executableHash: verifiedBuild.executableHash,
      programHash: verifiedBuild.programHash,
    },
  });

  console.log(`[m20] artifacts written under ${outDir}`);
  runPassthrough('node', [
    'scripts/check-mainnet-receipt-consistency.mjs',
    '--rpc-url',
    rpcUrl,
    '--manifest-path',
    manifestPath,
  ]);
}

try {
  main();
} catch (error) {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`[m20] deploy failed: ${msg}`);
  process.exit(1);
}
