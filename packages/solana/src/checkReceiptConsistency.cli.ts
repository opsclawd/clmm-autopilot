import { checkReceiptConsistency } from './checkReceiptConsistency';

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cluster = args.cluster;
  if (cluster !== 'devnet' && cluster !== 'mainnet') {
    throw new Error(`--cluster must be 'devnet' or 'mainnet' (received ${String(cluster)})`);
  }

  const rpcUrl =
    typeof args['rpc-url'] === 'string'
      ? args['rpc-url']
      : process.env.SOLANA_RPC_URL ?? process.env.RPC_URL ?? undefined;
  const manifestPath =
    typeof args['manifest-path'] === 'string' ? args['manifest-path'] : process.env.RECEIPT_MANIFEST_PATH ?? undefined;

  const result = await checkReceiptConsistency({
    cluster,
    rpcUrl,
    manifestPath,
  });

  console.log(JSON.stringify({ ok: true, ...result }));
}

void main();
