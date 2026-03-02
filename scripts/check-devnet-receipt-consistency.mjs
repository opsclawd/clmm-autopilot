#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const manifestPath = resolve(repoRoot, 'deployments/devnet/receipt.json');

if (!existsSync(manifestPath)) {
  console.error(`manifest not found: ${manifestPath}`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
for (const field of ['programId', 'idlPath', 'idlHashMode', 'idlHash']) {
  if (typeof manifest[field] !== 'string' || manifest[field].trim() === '') {
    console.error(`manifest field missing/invalid: ${field}`);
    process.exit(1);
  }
}

for (const field of ['deployedAt', 'gitCommit']) {
  if (typeof manifest[field] !== 'string' || manifest[field].trim() === '' || manifest[field].trim().toLowerCase() === 'unknown') {
    console.error(`manifest deployment metadata missing/placeholder: ${field}`);
    process.exit(1);
  }
}

const cmd = ['-C', 'packages/solana', 'exec', 'vite-node', 'src/checkDevnetReceiptConsistency.cli.ts'];
const out = spawnSync('pnpm', cmd, { stdio: 'inherit' });

if (out.status !== 0) {
  process.exit(out.status ?? 1);
}
