#!/usr/bin/env node
import { execSync } from 'node:child_process';

const REQUIRED = [
  { cmd: 'solana --version', name: 'solana CLI', expected: '2.3.0' },
  { cmd: 'solana-test-validator --version', name: 'solana-test-validator', expected: '2.3.0' },
  { cmd: 'anchor --version', name: 'anchor CLI', expected: '0.32.1' },
];

let ok = true;

for (const item of REQUIRED) {
  try {
    const out = execSync(item.cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const hasExpected = out.includes(item.expected);
    if (!hasExpected) ok = false;
    console.log(`${hasExpected ? '✓' : '✗'} ${item.name}: ${out} (expected contains ${item.expected})`);
  } catch {
    ok = false;
    console.log(`✗ ${item.name}: not found in PATH`);
  }
}

if (!ok) {
  console.error('\nTooling preflight failed. Install pinned versions, then re-run.');
  process.exit(1);
}

console.log('\nTooling preflight passed.');
