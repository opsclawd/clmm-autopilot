import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { computeReceiptIdlHashFullV1 } from './receiptIdentity';

async function main(): Promise<void> {
  const idlPath = process.argv[2] ? resolve(process.argv[2]) : resolve(process.cwd(), '../../deployments/devnet/receipt.idl.json');
  const raw = await readFile(idlPath, 'utf8');
  const idl = JSON.parse(raw);
  const hash = computeReceiptIdlHashFullV1(idl);
  console.log(hash);
}

void main();
