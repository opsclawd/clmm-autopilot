import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CORE_SRC = path.join(ROOT, 'packages/core/src');
const CORE_PKG = path.join(ROOT, 'packages/core/package.json');

const forbiddenModules = [
  '@solana/web3.js',
  '@solana/',
  '@orca-so/',
  '@raydium-io/',
  '@kamino-finance/',
  '@clmm-autopilot/solana',
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

function extractSpecifiers(source) {
  const out = [];
  const importExport = /(?:import|export)\s+(?:[^'"`]*?\s+from\s+)?["'`]([^"'`]+)["'`]/g;
  const dynamicImport = /import\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
  const requireCall = /require\(\s*["'`]([^"'`]+)["'`]\s*\)/g;

  for (const re of [importExport, dynamicImport, requireCall]) {
    let match;
    while ((match = re.exec(source)) !== null) out.push(match[1]);
  }
  return out;
}

function candidateResolutionPaths(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const extCandidates = ['', '.ts', '.tsx', '.mts', '.cts'];
  const out = [];

  for (const ext of extCandidates) out.push(base + ext);
  for (const ext of ['.ts', '.tsx', '.mts', '.cts']) out.push(path.join(base, `index${ext}`));

  return [...new Set(out.map((p) => path.normalize(p)))];
}

function relativeImportViolation(fromFile, spec) {
  const candidates = candidateResolutionPaths(fromFile, spec);
  const coreRoot = path.normalize(CORE_SRC + path.sep);
  const solanaRoot = path.normalize(path.join(ROOT, 'packages/solana') + path.sep);
  const appsRoot = path.normalize(path.join(ROOT, 'apps') + path.sep);

  // If any candidate already clearly points outside core/src, fail hard.
  for (const resolved of candidates) {
    if (resolved.startsWith(solanaRoot)) return `forbidden relative import into packages/solana: ${spec}`;
    if (resolved.startsWith(appsRoot)) return `forbidden relative import into apps/: ${spec}`;
    if (!resolved.startsWith(coreRoot)) return `relative import escapes packages/core/src: ${spec}`;
  }

  return null;
}

function isForbiddenSpecifier(fromFile, spec) {
  if (forbiddenModules.some((m) => spec === m || spec.startsWith(m))) return `forbidden module import: ${spec}`;

  if (spec.startsWith('@clmm-autopilot/')) {
    if (spec !== '@clmm-autopilot/core') return `forbidden workspace import from core: ${spec}`;
  }

  if (spec.startsWith('../') || spec.startsWith('./')) {
    return relativeImportViolation(fromFile, spec);
  }

  const normalized = spec.replace(/^\/+/, '');
  if (normalized.startsWith('packages/solana')) return `forbidden cross-layer path import: ${spec}`;
  if (normalized.startsWith('apps/')) return `forbidden cross-layer path import: ${spec}`;

  return null;
}

const violations = [];
for (const file of collectTsFiles(CORE_SRC)) {
  const txt = fs.readFileSync(file, 'utf8');
  for (const spec of extractSpecifiers(txt)) {
    const why = isForbiddenSpecifier(file, spec);
    if (why) violations.push(`${path.relative(ROOT, file)} -> ${why}`);
  }
}

const pkg = JSON.parse(fs.readFileSync(CORE_PKG, 'utf8'));
const depFields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
for (const field of depFields) {
  const deps = pkg[field] || {};
  for (const name of Object.keys(deps)) {
    if (
      name.includes('solana') ||
      name.includes('orca') ||
      name.includes('raydium') ||
      name.includes('kamino') ||
      name === '@clmm-autopilot/solana'
    ) {
      violations.push(`packages/core/package.json has forbidden ${field} entry: ${name}`);
    }
  }
}

if (violations.length) {
  console.error('Boundary check failed:\n' + violations.map((v) => `- ${v}`).join('\n'));
  process.exit(1);
}

console.log('Boundary check passed for packages/core');
