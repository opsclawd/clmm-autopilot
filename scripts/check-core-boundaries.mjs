import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CORE_SRC = path.join(ROOT, 'packages/core/src');
const CORE_PKG = path.join(ROOT, 'packages/core/package.json');

const forbidden = [
  '@solana/web3.js',
  '@solana/',
  '@orca-so/',
  '@raydium-io/',
  '@kamino-finance/',
  '@clmm-autopilot/solana',
  'packages/solana',
];

function collectTsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(p));
    else if (entry.isFile() && /\.(ts|tsx|mts|cts)$/.test(entry.name)) out.push(p);
  }
  return out;
}

let violations = [];
for (const file of collectTsFiles(CORE_SRC)) {
  const txt = fs.readFileSync(file, 'utf8');
  for (const token of forbidden) {
    if (txt.includes(token)) violations.push(`${path.relative(ROOT, file)} contains forbidden token: ${token}`);
  }
}

const pkg = JSON.parse(fs.readFileSync(CORE_PKG, 'utf8'));
const depFields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
for (const field of depFields) {
  const deps = pkg[field] || {};
  for (const name of Object.keys(deps)) {
    if (name.includes('solana') || name.includes('orca') || name.includes('raydium') || name === '@clmm-autopilot/solana') {
      violations.push(`packages/core/package.json has forbidden ${field} entry: ${name}`);
    }
  }
}

if (violations.length) {
  console.error('Boundary check failed:\n' + violations.map(v => `- ${v}`).join('\n'));
  process.exit(1);
}

console.log('Boundary check passed for packages/core');
