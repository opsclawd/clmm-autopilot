#!/usr/bin/env node
import { runPassthrough } from './receipt-release-lib.mjs';

try {
  runPassthrough('pnpm', ['-C', 'packages/solana', 'exec', 'vite-node', 'src/checkReceiptConsistency.cli.ts', '--cluster', 'devnet']);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[m15] consistency check failed: ${message}`);
  process.exit(1);
}
