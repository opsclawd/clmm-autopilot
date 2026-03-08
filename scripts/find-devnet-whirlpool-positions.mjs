#!/usr/bin/env node
import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount } from '@solana/spl-token';
import { PDAUtil, ParsablePosition, ParsablePositionBundle, PositionBundleUtil } from '@orca-so/whirlpools-sdk';

const ORCA_WHIRLPOOL_PROGRAM_ID = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');

function usage() {
  console.log(`Usage:
  node scripts/find-devnet-whirlpool-positions.mjs --wallet <WALLET_PUBKEY> [--rpc <RPC_URL>]

Env fallbacks:
  WALLET_ADDRESS
  RPC_URL (default: https://api.devnet.solana.com)
`);
}

function arg(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function collectNftLikeMints(connection, wallet, tokenProgramId) {
  const tokenAccounts = await connection.getTokenAccountsByOwner(wallet, { programId: tokenProgramId }, 'confirmed');
  const mintOwners = [];

  tokenAccounts.value.forEach(({ pubkey, account }) => {
    try {
      const parsed = unpackAccount(pubkey, account, tokenProgramId);
      if (parsed.amount === 1n) {
        mintOwners.push({
          mint: parsed.mint,
          tokenProgramId,
        });
      }
    } catch {
      // Ignore malformed token accounts and continue scanning.
    }
  });

  return mintOwners;
}

function dedupeMintOwners(...lists) {
  const map = new Map();
  lists.flat().forEach(({ mint, tokenProgramId }) => {
    const key = mint.toBase58();
    if (!map.has(key)) {
      map.set(key, { mint, tokenProgramId });
    }
  });
  return [...map.values()];
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    usage();
    process.exit(0);
  }

  const rpc = arg('--rpc') || process.env.RPC_URL || 'https://api.devnet.solana.com';
  const walletRaw = arg('--wallet') || process.env.WALLET_ADDRESS;
  if (!walletRaw) {
    console.error('Missing wallet pubkey. Pass --wallet or WALLET_ADDRESS.');
    usage();
    process.exit(1);
  }

  const wallet = new PublicKey(walletRaw);
  const connection = new Connection(rpc, 'confirmed');

  const [tokenProgramMints, token2022Mints] = await Promise.all([
    collectNftLikeMints(connection, wallet, TOKEN_PROGRAM_ID),
    collectNftLikeMints(connection, wallet, TOKEN_2022_PROGRAM_ID),
  ]);
  const mintOwners = dedupeMintOwners(tokenProgramMints, token2022Mints);

  const candidatePositions = mintOwners.map(({ mint, tokenProgramId }) => ({
    mint: mint.toBase58(),
    tokenProgramId: tokenProgramId.toBase58(),
    positionPda: PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, mint).publicKey,
  }));
  const candidateBundles = mintOwners.map(({ mint, tokenProgramId }) => ({
    mint: mint.toBase58(),
    tokenProgramId: tokenProgramId.toBase58(),
    positionBundlePda: PDAUtil.getPositionBundle(ORCA_WHIRLPOOL_PROGRAM_ID, mint).publicKey,
  }));

  const found = [];
  for (const group of chunk(candidatePositions, 100)) {
    const infos = await connection.getMultipleAccountsInfo(group.map((x) => x.positionPda), 'confirmed');
    infos.forEach((info, i) => {
      if (!info) return;
      if (!info.owner.equals(ORCA_WHIRLPOOL_PROGRAM_ID)) return;
      const decoded = ParsablePosition.parse(group[i].positionPda, info);
      if (!decoded) return;
      found.push({
        type: 'position',
        positionAddress: group[i].positionPda.toBase58(),
        positionMint: group[i].mint,
        tokenProgramId: group[i].tokenProgramId,
        whirlpool: decoded.whirlpool.toBase58(),
        lowerTickIndex: decoded.tickLowerIndex,
        upperTickIndex: decoded.tickUpperIndex,
      });
    });
  }

  const bundleCandidatesFound = [];
  for (const group of chunk(candidateBundles, 100)) {
    const infos = await connection.getMultipleAccountsInfo(group.map((x) => x.positionBundlePda), 'confirmed');
    infos.forEach((info, i) => {
      if (!info) return;
      if (!info.owner.equals(ORCA_WHIRLPOOL_PROGRAM_ID)) return;
      const bundle = ParsablePositionBundle.parse(group[i].positionBundlePda, info);
      if (!bundle) return;
      bundleCandidatesFound.push({
        bundleAddress: group[i].positionBundlePda,
        bundleMint: bundle.positionBundleMint,
        bundleIndexes: PositionBundleUtil.getOccupiedBundleIndexes(bundle),
      });
    });
  }

  const bundledPositionCandidates = [];
  bundleCandidatesFound.forEach(({ bundleAddress, bundleMint, bundleIndexes }) => {
    bundleIndexes.forEach((bundleIndex) => {
      const bundledPosition = PDAUtil.getBundledPosition(
        ORCA_WHIRLPOOL_PROGRAM_ID,
        bundleMint,
        bundleIndex,
      ).publicKey;
      bundledPositionCandidates.push({
        bundleAddress: bundleAddress.toBase58(),
        bundleMint: bundleMint.toBase58(),
        bundleIndex,
        positionPda: bundledPosition,
      });
    });
  });

  for (const group of chunk(bundledPositionCandidates, 100)) {
    const infos = await connection.getMultipleAccountsInfo(group.map((x) => x.positionPda), 'confirmed');
    infos.forEach((info, i) => {
      if (!info) return;
      if (!info.owner.equals(ORCA_WHIRLPOOL_PROGRAM_ID)) return;
      const decoded = ParsablePosition.parse(group[i].positionPda, info);
      if (!decoded) return;
      found.push({
        type: 'bundledPosition',
        positionAddress: group[i].positionPda.toBase58(),
        positionMint: decoded.positionMint.toBase58(),
        bundleAddress: group[i].bundleAddress,
        bundleMint: group[i].bundleMint,
        bundleIndex: group[i].bundleIndex,
        whirlpool: decoded.whirlpool.toBase58(),
        lowerTickIndex: decoded.tickLowerIndex,
        upperTickIndex: decoded.tickUpperIndex,
      });
    });
  }

  const payload = {
    rpc,
    wallet: wallet.toBase58(),
    candidatesScanned: {
      mintsFromTokenProgram: tokenProgramMints.length,
      mintsFromToken2022Program: token2022Mints.length,
      uniqueMints: mintOwners.length,
      standardPositionPdas: candidatePositions.length,
      bundlePdas: candidateBundles.length,
      bundledPositionPdas: bundledPositionCandidates.length,
    },
    positionsFound: found.length,
    positions: found,
  };

  console.log(JSON.stringify(payload, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err?.message ?? String(err) }));
  process.exit(1);
});
