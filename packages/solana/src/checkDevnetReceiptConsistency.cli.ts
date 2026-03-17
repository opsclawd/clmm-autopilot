import { checkReceiptConsistency } from './checkReceiptConsistency';

async function main(): Promise<void> {
  const result = await checkReceiptConsistency({
    cluster: 'devnet',
    rpcUrl: process.env.SOLANA_RPC_URL ?? process.env.RPC_URL ?? 'https://api.devnet.solana.com',
  });

  console.log(JSON.stringify({ ok: true, ...result }));
}

void main();
