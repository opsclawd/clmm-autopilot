#!/usr/bin/env node
import { assertPinnedToolchain, buildReceipt, parseArgs } from './receipt-release-lib.mjs';

try {
  const args = parseArgs(process.argv.slice(2));
  const verifiable = args.verifiable === true;
  assertPinnedToolchain({ requireSolanaVerify: verifiable });
  buildReceipt({ verifiable });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[receipt:build] failed: ${message}`);
  process.exit(1);
}
