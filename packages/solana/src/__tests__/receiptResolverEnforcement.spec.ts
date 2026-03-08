import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const SOLANA_SRC_DIR = join(THIS_DIR, '..');
const ALLOWED_FILES = new Set(['receiptIdentity.ts', 'executionBuilder.ts']);
const RECEIPT_CONFIG_FIELDS = [
  'receiptProgramId',
  'receiptIdlHashMode',
  'receiptIdlHash',
  'receiptIdlPath',
  'expectedUpgradeAuthority',
];

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (entry === '__tests__') continue;
      out.push(...collectTsFiles(p));
      continue;
    }
    if (st.isFile() && p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('receipt resolver enforcement', () => {
  it('prevents direct reads of receipt identity config fields outside resolver', () => {
    const offenders: string[] = [];
    for (const file of collectTsFiles(SOLANA_SRC_DIR)) {
      const basename = file.split('/').pop() ?? file;
      if (ALLOWED_FILES.has(basename)) continue;
      const src = readFileSync(file, 'utf8');
      for (const field of RECEIPT_CONFIG_FIELDS) {
        const pattern = new RegExp(`\\bconfig\\.${field}\\b`);
        if (pattern.test(src)) {
          offenders.push(`${file} reads config.${field}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
