import { createSqliteLocalReceiptLedger, type LocalReceiptStatus } from './localReceiptLedger';

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) continue;
    const key = raw.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function parseStatus(raw: string | undefined): LocalReceiptStatus | undefined {
  if (!raw) return undefined;
  if (raw === 'pending' || raw === 'confirmed' || raw === 'failed') return raw;
  throw new Error(`--status must be one of: pending, confirmed, failed (received '${raw}')`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = args['db-path'];
  if (!dbPath) {
    throw new Error('--db-path is required');
  }

  const ledger = createSqliteLocalReceiptLedger(dbPath);
  try {
    const rows = ledger.list({
      authority: args.authority,
      positionMint: args['position-mint'],
      positionAddress: args['position-address'],
      epoch: args.epoch ? Number(args.epoch) : undefined,
      status: parseStatus(args.status),
    });
    console.log(
      JSON.stringify(
        {
          ok: true,
          dbPath: ledger.dbPath,
          count: rows.length,
          rows,
        },
        null,
        2,
      ),
    );
  } finally {
    ledger.close();
  }
}

void main();
