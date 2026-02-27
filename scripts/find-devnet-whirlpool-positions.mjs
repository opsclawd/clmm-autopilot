#!/usr/bin/env node
import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

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

function parsePositionAccount(data) {
  if (data.length < 128) return null;
  return {
    whirlpool: new PublicKey(data.subarray(8, 40)).toBase58(),
    positionMint: new PublicKey(data.subarray(40, 72)).toBase58(),
    lowerTickIndex: data.readInt32LE(88),
    upperTickIndex: data.readInt32LE(92),
  };
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

  const parsed = await connection.getParsedTokenAccountsByOwner(wallet, { programId: TOKEN_PROGRAM_ID });

  const nftLikeMints = parsed.value
    .map((x) => x.account.data.parsed?.info)
    .filter(Boolean)
    .filter((info) => {
      const amount = info.tokenAmount;
      return amount && amount.amount === '1' && amount.decimals === 0;
    })
    .map((info) => info.mint)
    .map((mint) => new PublicKey(mint));

  const candidatePdas = nftLikeMints.map((mint) => {
    const [positionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('position'), mint.toBuffer()],
      ORCA_WHIRLPOOL_PROGRAM_ID,
    );
    return { mint: mint.toBase58(), positionPda };
  });

  const found = [];
  for (const group of chunk(candidatePdas, 100)) {
    const infos = await connection.getMultipleAccountsInfo(group.map((x) => x.positionPda), 'confirmed');
    infos.forEach((info, i) => {
      if (!info) return;
      if (!info.owner.equals(ORCA_WHIRLPOOL_PROGRAM_ID)) return;
      const decoded = parsePositionAccount(info.data);
      found.push({
        positionAddress: group[i].positionPda.toBase58(),
        positionMint: group[i].mint,
        ...(decoded ?? {}),
      });
    });
  }

  const payload = {
    rpc,
    wallet: wallet.toBase58(),
    candidatesScanned: candidatePdas.length,
    positionsFound: found.length,
    positions: found,
  };

  console.log(JSON.stringify(payload, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err?.message ?? String(err) }));
  process.exit(1);
});
