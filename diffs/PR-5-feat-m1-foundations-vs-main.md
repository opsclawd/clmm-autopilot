# PR 5 Diff: feat/m1-foundations vs main

Generated: 2026-02-21 17:40:07Z

## Diff Stat

```
 .github/workflows/ci.yml                           |    3 +
 apps/mobile/App.tsx                                |   61 +-
 apps/mobile/eslint.config.js                       |   10 +
 apps/mobile/package.json                           |    6 +-
 apps/mobile/src/mwaSmoke.ts                        |   32 +
 apps/web/src/app/page.tsx                          |   67 +-
 docs/runbooks/mobile-mwa.md                        |   33 +
 packages/core/package.json                         |    7 +-
 packages/core/src/__tests__/core.spec.ts           |   23 +
 packages/core/src/index.ts                         |   23 +-
 packages/solana/package.json                       |    9 +-
 packages/solana/src/__tests__/config.spec.ts       |   18 +
 packages/solana/src/__tests__/errors.spec.ts       |   19 +
 .../solana/src/__tests__/rpc.integration.spec.ts   |   27 +
 packages/solana/src/config.ts                      |   26 +
 packages/solana/src/errors.ts                      |   23 +
 packages/solana/src/index.ts                       |    6 +-
 packages/solana/src/rpc.ts                         |   21 +
 packages/solana/src/types.ts                       |   24 +
 pnpm-lock.yaml                                     | 1828 ++++++++++++++++++--
 scripts/check-core-boundaries.mjs                  |   52 +
 specs/m1-foundations.spec.md                       |    2 +-
 22 files changed, 2092 insertions(+), 228 deletions(-)
```

## Full Patch

```diff
diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
index bb4545e..c39c11e 100644
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -61,6 +61,9 @@ jobs:
       - name: pnpm -r lint
         run: pnpm -r lint
 
+      - name: Boundary gate (packages/core purity + dependency direction)
+        run: pnpm --filter @clmm-autopilot/core lint
+
       - name: Setup Rust (for Anchor)
         uses: dtolnay/rust-toolchain@stable
         with:
diff --git a/apps/mobile/App.tsx b/apps/mobile/App.tsx
index 0329d0c..1035c29 100644
--- a/apps/mobile/App.tsx
+++ b/apps/mobile/App.tsx
@@ -1,20 +1,55 @@
 import { StatusBar } from 'expo-status-bar';
-import { StyleSheet, Text, View } from 'react-native';
+import { useState } from 'react';
+import { Button, SafeAreaView, ScrollView, Text, View } from 'react-native';
+import { runMwaSignMessageSmoke } from './src/mwaSmoke';
 
 export default function App() {
+  const [publicKey, setPublicKey] = useState<string>('');
+  const [signature, setSignature] = useState<string>('');
+  const [error, setError] = useState<string>('');
+  const [busy, setBusy] = useState(false);
+
   return (
-    <View style={styles.container}>
-      <Text>Open up App.tsx to start working on your app!</Text>
+    <SafeAreaView style={{ flex: 1, backgroundColor: '#fff' }}>
+      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
+        <Text style={{ fontSize: 24, fontWeight: '700' }}>M1 MWA Smoke</Text>
+        <Text>Connect wallet and sign message on devnet.</Text>
+        <Button
+          title={busy ? 'Signing…' : 'Run MWA sign-message smoke'}
+          disabled={busy}
+          onPress={async () => {
+            setBusy(true);
+            setError('');
+            try {
+              const result = await runMwaSignMessageSmoke();
+              setPublicKey(result.publicKey);
+              setSignature(result.signatureHex);
+            } catch (e) {
+              setError(e instanceof Error ? e.message : String(e));
+            } finally {
+              setBusy(false);
+            }
+          }}
+        />
+
+        <View style={{ gap: 6 }}>
+          <Text style={{ fontWeight: '600' }}>Public key</Text>
+          <Text selectable>{publicKey || '—'}</Text>
+        </View>
+
+        <View style={{ gap: 6 }}>
+          <Text style={{ fontWeight: '600' }}>Signature (hex)</Text>
+          <Text selectable>{signature || '—'}</Text>
+        </View>
+
+        {error ? (
+          <View style={{ gap: 6 }}>
+            <Text style={{ fontWeight: '600', color: 'red' }}>Error</Text>
+            <Text selectable style={{ color: 'red' }}>{error}</Text>
+          </View>
+        ) : null}
+      </ScrollView>
       <StatusBar style="auto" />
-    </View>
+    </SafeAreaView>
   );
 }
-
-const styles = StyleSheet.create({
-  container: {
-    flex: 1,
-    backgroundColor: '#fff',
-    alignItems: 'center',
-    justifyContent: 'center',
-  },
-});
diff --git a/apps/mobile/eslint.config.js b/apps/mobile/eslint.config.js
new file mode 100644
index 0000000..ba708ed
--- /dev/null
+++ b/apps/mobile/eslint.config.js
@@ -0,0 +1,10 @@
+// https://docs.expo.dev/guides/using-eslint/
+const { defineConfig } = require('eslint/config');
+const expoConfig = require("eslint-config-expo/flat");
+
+module.exports = defineConfig([
+  expoConfig,
+  {
+    ignores: ["dist/*"],
+  }
+]);
diff --git a/apps/mobile/package.json b/apps/mobile/package.json
index 06c6b9a..6ce8d52 100644
--- a/apps/mobile/package.json
+++ b/apps/mobile/package.json
@@ -9,9 +9,13 @@
     "web": "expo start --web",
     "test": "echo \"(mobile) no tests yet\"",
     "typecheck": "tsc --noEmit",
-    "lint": "expo lint"
+    "lint": "expo lint",
+    "smoke:mwa": "expo start --dev-client"
   },
   "dependencies": {
+    "@solana-mobile/mobile-wallet-adapter-protocol-web3js": "^2.2.0",
+    "@solana/web3.js": "^1.98.4",
+    "bs58": "^6.0.0",
     "expo": "~54.0.33",
     "expo-status-bar": "~3.0.9",
     "react": "19.1.0",
diff --git a/apps/mobile/src/mwaSmoke.ts b/apps/mobile/src/mwaSmoke.ts
new file mode 100644
index 0000000..2952463
--- /dev/null
+++ b/apps/mobile/src/mwaSmoke.ts
@@ -0,0 +1,32 @@
+export type MwaSmokeResult = {
+  publicKey: string;
+  signatureHex: string;
+};
+
+export async function runMwaSignMessageSmoke(): Promise<MwaSmokeResult> {
+  const mwa = await import('@solana-mobile/mobile-wallet-adapter-protocol-web3js');
+  const payload = new TextEncoder().encode('clmm-autopilot-m1-mwa-smoke');
+
+  return mwa.transact(async (wallet: any) => {
+    const auth = await wallet.authorize({
+      chain: 'solana:devnet',
+      identity: { name: 'CLMM Autopilot' },
+    });
+
+    const account = auth.accounts[0];
+    const signed = await wallet.signMessages({
+      addresses: [account.address],
+      payloads: [payload],
+    });
+
+    const sigBytes: Uint8Array = signed.signedPayloads[0];
+    const signatureHex = Array.from(sigBytes)
+      .map((b) => b.toString(16).padStart(2, '0'))
+      .join('');
+
+    return {
+      publicKey: account.address,
+      signatureHex,
+    } satisfies MwaSmokeResult;
+  });
+}
diff --git a/apps/web/src/app/page.tsx b/apps/web/src/app/page.tsx
index 295f8fd..bd1fd50 100644
--- a/apps/web/src/app/page.tsx
+++ b/apps/web/src/app/page.tsx
@@ -1,65 +1,10 @@
-import Image from "next/image";
-
 export default function Home() {
   return (
-    <div className="flex min-h-screen items-center justify-center bg-zinc-50 font-sans dark:bg-black">
-      <main className="flex min-h-screen w-full max-w-3xl flex-col items-center justify-between py-32 px-16 bg-white dark:bg-black sm:items-start">
-        <Image
-          className="dark:invert"
-          src="/next.svg"
-          alt="Next.js logo"
-          width={100}
-          height={20}
-          priority
-        />
-        <div className="flex flex-col items-center gap-6 text-center sm:items-start sm:text-left">
-          <h1 className="max-w-xs text-3xl font-semibold leading-10 tracking-tight text-black dark:text-zinc-50">
-            To get started, edit the page.tsx file.
-          </h1>
-          <p className="max-w-md text-lg leading-8 text-zinc-600 dark:text-zinc-400">
-            Looking for a starting point or more instructions? Head over to{" "}
-            <a
-              href="https://vercel.com/templates?framework=next.js&utm_source=create-next-app&utm_medium=appdir-template-tw&utm_campaign=create-next-app"
-              className="font-medium text-zinc-950 dark:text-zinc-50"
-            >
-              Templates
-            </a>{" "}
-            or the{" "}
-            <a
-              href="https://nextjs.org/learn?utm_source=create-next-app&utm_medium=appdir-template-tw&utm_campaign=create-next-app"
-              className="font-medium text-zinc-950 dark:text-zinc-50"
-            >
-              Learning
-            </a>{" "}
-            center.
-          </p>
-        </div>
-        <div className="flex flex-col gap-4 text-base font-medium sm:flex-row">
-          <a
-            className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-foreground px-5 text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc] md:w-[158px]"
-            href="https://vercel.com/new?utm_source=create-next-app&utm_medium=appdir-template-tw&utm_campaign=create-next-app"
-            target="_blank"
-            rel="noopener noreferrer"
-          >
-            <Image
-              className="dark:invert"
-              src="/vercel.svg"
-              alt="Vercel logomark"
-              width={16}
-              height={16}
-            />
-            Deploy Now
-          </a>
-          <a
-            className="flex h-12 w-full items-center justify-center rounded-full border border-solid border-black/[.08] px-5 transition-colors hover:border-transparent hover:bg-black/[.04] dark:border-white/[.145] dark:hover:bg-[#1a1a1a] md:w-[158px]"
-            href="https://nextjs.org/docs?utm_source=create-next-app&utm_medium=appdir-template-tw&utm_campaign=create-next-app"
-            target="_blank"
-            rel="noopener noreferrer"
-          >
-            Documentation
-          </a>
-        </div>
-      </main>
-    </div>
+    <main className="p-6 font-sans">
+      <h1 className="text-2xl font-bold">CLMM Autopilot — M1 Foundations</h1>
+      <p className="mt-2 text-sm text-gray-700">
+        Web shell is intentionally minimal for M1. Business logic remains in packages.
+      </p>
+    </main>
   );
 }
diff --git a/docs/runbooks/mobile-mwa.md b/docs/runbooks/mobile-mwa.md
new file mode 100644
index 0000000..afc8f13
--- /dev/null
+++ b/docs/runbooks/mobile-mwa.md
@@ -0,0 +1,33 @@
+# Mobile MWA smoke runbook (M1)
+
+## Prereqs
+
+- Android emulator or physical Android device
+- A Solana mobile wallet that supports MWA
+
+## Install + run
+
+```bash
+pnpm install
+pnpm --filter @clmm-autopilot/mobile start
+```
+
+Then launch Android:
+
+```bash
+pnpm --filter @clmm-autopilot/mobile android
+```
+
+## Smoke steps
+
+1. Open the app.
+2. Tap **Run MWA sign-message smoke**.
+3. Approve wallet authorization + message signing.
+4. Verify the app displays:
+   - wallet public key
+   - signature (base64)
+
+## Notes
+
+- Uses devnet chain id (`solana:devnet`).
+- CI does not perform interactive signing; this runbook is for local/device verification.
diff --git a/packages/core/package.json b/packages/core/package.json
index e91f3f2..7bd6fca 100644
--- a/packages/core/package.json
+++ b/packages/core/package.json
@@ -5,11 +5,12 @@
   "type": "module",
   "main": "src/index.ts",
   "scripts": {
-    "test": "echo \"(core) no tests yet\"",
-    "lint": "echo \"(core) lint handled at repo root\"",
+    "test": "vitest run",
+    "lint": "node ../../scripts/check-core-boundaries.mjs",
     "typecheck": "tsc -p tsconfig.json --noEmit"
   },
   "devDependencies": {
-    "typescript": "^5.9.3"
+    "typescript": "^5.9.3",
+    "vitest": "^3.2.4"
   }
 }
diff --git a/packages/core/src/__tests__/core.spec.ts b/packages/core/src/__tests__/core.spec.ts
new file mode 100644
index 0000000..1d121ef
--- /dev/null
+++ b/packages/core/src/__tests__/core.spec.ts
@@ -0,0 +1,23 @@
+import { describe, expect, it } from 'vitest';
+import { clamp, hasConsecutive, movingAverage } from '../index';
+
+describe('core math helpers', () => {
+  it('clamp and movingAverage behave deterministically', () => {
+    expect(clamp(10, 0, 5)).toBe(5);
+    expect(clamp(-10, 0, 5)).toBe(0);
+    expect(clamp(3, 0, 5)).toBe(3);
+    expect(() => clamp(1, 5, 0)).toThrow();
+
+    expect(movingAverage([2])).toBe(2);
+    expect(movingAverage([2, 4, 6])).toBe(4);
+    expect(movingAverage([1, 1, 1, 1])).toBe(1);
+  });
+
+  it('hasConsecutive detects streaks correctly', () => {
+    expect(hasConsecutive(['HOLD', 'DOWN', 'DOWN', 'DOWN'], 'DOWN', 3)).toBe(true);
+    expect(hasConsecutive(['DOWN', 'UP', 'DOWN', 'DOWN'], 'DOWN', 3)).toBe(false);
+    expect(hasConsecutive([1, 1, 2, 1, 1, 1], 1, 3)).toBe(true);
+    expect(hasConsecutive([1, 2, 3], 4, 1)).toBe(false);
+    expect(hasConsecutive([1, 2, 3], 1, 0)).toBe(true);
+  });
+});
diff --git a/packages/core/src/index.ts b/packages/core/src/index.ts
index 61ceedb..8839f09 100644
--- a/packages/core/src/index.ts
+++ b/packages/core/src/index.ts
@@ -1,2 +1,21 @@
-// Pure TS core utilities (no Solana RPC, no UI).
-export const CORE_PLACEHOLDER = true;
+export type NonEmptyArray<T> = [T, ...T[]];
+
+export function clamp(value: number, min: number, max: number): number {
+  if (min > max) throw new Error('min must be <= max');
+  return Math.min(max, Math.max(min, value));
+}
+
+export function movingAverage(values: NonEmptyArray<number>): number {
+  const total = values.reduce((acc, v) => acc + v, 0);
+  return total / values.length;
+}
+
+export function hasConsecutive<T>(values: readonly T[], target: T, count: number): boolean {
+  if (count <= 0) return true;
+  let streak = 0;
+  for (const value of values) {
+    streak = value === target ? streak + 1 : 0;
+    if (streak >= count) return true;
+  }
+  return false;
+}
diff --git a/packages/solana/package.json b/packages/solana/package.json
index c907355..587d70c 100644
--- a/packages/solana/package.json
+++ b/packages/solana/package.json
@@ -5,11 +5,16 @@
   "type": "module",
   "main": "src/index.ts",
   "scripts": {
-    "test": "echo \"(solana) no tests yet\"",
+    "test": "vitest run",
     "lint": "echo \"(solana) lint handled at repo root\"",
     "typecheck": "tsc -p tsconfig.json --noEmit"
   },
   "devDependencies": {
-    "typescript": "^5.9.3"
+    "@types/node": "^20.19.33",
+    "typescript": "^5.9.3",
+    "vitest": "^3.2.4"
+  },
+  "dependencies": {
+    "@solana/web3.js": "^1.98.4"
   }
 }
diff --git a/packages/solana/src/__tests__/config.spec.ts b/packages/solana/src/__tests__/config.spec.ts
new file mode 100644
index 0000000..99404b6
--- /dev/null
+++ b/packages/solana/src/__tests__/config.spec.ts
@@ -0,0 +1,18 @@
+import { describe, expect, it } from 'vitest';
+import { loadSolanaConfig } from '../config';
+
+describe('loadSolanaConfig', () => {
+  it('uses defaults', () => {
+    expect(loadSolanaConfig({})).toEqual({
+      rpcUrl: 'https://api.devnet.solana.com',
+      cluster: 'devnet',
+      commitment: 'confirmed',
+    });
+  });
+
+  it('rejects invalid values', () => {
+    expect(() => loadSolanaConfig({ SOLANA_CLUSTER: 'staging' })).toThrow();
+    expect(() => loadSolanaConfig({ SOLANA_COMMITMENT: 'fast' })).toThrow();
+    expect(() => loadSolanaConfig({ SOLANA_RPC_URL: 'ws://bad' })).toThrow();
+  });
+});
diff --git a/packages/solana/src/__tests__/errors.spec.ts b/packages/solana/src/__tests__/errors.spec.ts
new file mode 100644
index 0000000..61c99d1
--- /dev/null
+++ b/packages/solana/src/__tests__/errors.spec.ts
@@ -0,0 +1,19 @@
+import { describe, expect, it } from 'vitest';
+import { normalizeSolanaError } from '../errors';
+
+describe('normalizeSolanaError', () => {
+  it('maps known failures', () => {
+    expect(normalizeSolanaError(new Error('blockhash not found')).code).toBe('BLOCKHASH_EXPIRED');
+    expect(normalizeSolanaError(new Error('simulation failed')).code).toBe('SIMULATION_FAILED');
+    expect(normalizeSolanaError(new Error('slippage exceeded')).code).toBe('SLIPPAGE_EXCEEDED');
+    expect(normalizeSolanaError(new Error('429 rate limit')).code).toBe('RPC_TRANSIENT');
+  });
+
+  it('falls back to permanent rpc error', () => {
+    expect(normalizeSolanaError('weird unknown')).toEqual({
+      code: 'RPC_PERMANENT',
+      message: 'weird unknown',
+      retryable: false,
+    });
+  });
+});
diff --git a/packages/solana/src/__tests__/rpc.integration.spec.ts b/packages/solana/src/__tests__/rpc.integration.spec.ts
new file mode 100644
index 0000000..0f85f5f
--- /dev/null
+++ b/packages/solana/src/__tests__/rpc.integration.spec.ts
@@ -0,0 +1,27 @@
+import { describe, expect, it } from 'vitest';
+import { createReadonlyRpc } from '../rpc';
+
+describe('readonly rpc wrapper (deterministic)', () => {
+  it('creates a stable surface', () => {
+    const rpc = createReadonlyRpc({
+      rpcUrl: 'https://api.devnet.solana.com',
+      cluster: 'devnet',
+      commitment: 'confirmed',
+    });
+
+    expect(typeof rpc.getSlot).toBe('function');
+    expect(typeof rpc.getLatestBlockhash).toBe('function');
+    expect(typeof rpc.getAccountInfoExists).toBe('function');
+  });
+
+  it.skipIf(process.env.RUN_DEVNET_TESTS !== '1')('optional devnet smoke', async () => {
+    const rpc = createReadonlyRpc({
+      rpcUrl: 'https://api.devnet.solana.com',
+      cluster: 'devnet',
+      commitment: 'confirmed',
+    });
+
+    const slot = await rpc.getSlot();
+    expect(slot).toBeGreaterThan(0);
+  });
+});
diff --git a/packages/solana/src/config.ts b/packages/solana/src/config.ts
new file mode 100644
index 0000000..13a6070
--- /dev/null
+++ b/packages/solana/src/config.ts
@@ -0,0 +1,26 @@
+import type { SolanaConfig } from './types';
+
+const allowedClusters = new Set(['devnet', 'mainnet-beta', 'localnet']);
+const allowedCommitments = new Set(['processed', 'confirmed', 'finalized']);
+
+export function loadSolanaConfig(env: Record<string, string | undefined> = process.env): SolanaConfig {
+  const rpcUrl = env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
+  const cluster = (env.SOLANA_CLUSTER ?? 'devnet') as SolanaConfig['cluster'];
+  const commitment = (env.SOLANA_COMMITMENT ?? 'confirmed') as SolanaConfig['commitment'];
+
+  if (!allowedClusters.has(cluster)) throw new Error(`Invalid SOLANA_CLUSTER: ${cluster}`);
+  if (!allowedCommitments.has(commitment)) throw new Error(`Invalid SOLANA_COMMITMENT: ${commitment}`);
+
+  let parsed: URL;
+  try {
+    parsed = new URL(rpcUrl);
+  } catch {
+    throw new Error(`Invalid SOLANA_RPC_URL: ${rpcUrl}`);
+  }
+
+  if (!['http:', 'https:'].includes(parsed.protocol)) {
+    throw new Error(`Invalid SOLANA_RPC_URL protocol: ${parsed.protocol}`);
+  }
+
+  return { rpcUrl, cluster, commitment };
+}
diff --git a/packages/solana/src/errors.ts b/packages/solana/src/errors.ts
new file mode 100644
index 0000000..8c6d8e5
--- /dev/null
+++ b/packages/solana/src/errors.ts
@@ -0,0 +1,23 @@
+import type { NormalizedError } from './types';
+
+const transientHints = ['timeout', '429', 'rate limit', 'temporarily unavailable', 'econnreset'];
+
+export function normalizeSolanaError(error: unknown): NormalizedError {
+  const msg = error instanceof Error ? error.message : String(error ?? 'Unknown error');
+  const lower = msg.toLowerCase();
+
+  if (lower.includes('blockhash')) {
+    return { code: 'BLOCKHASH_EXPIRED', message: msg, retryable: true };
+  }
+  if (lower.includes('simulation')) {
+    return { code: 'SIMULATION_FAILED', message: msg, retryable: false };
+  }
+  if (lower.includes('slippage')) {
+    return { code: 'SLIPPAGE_EXCEEDED', message: msg, retryable: false };
+  }
+  if (transientHints.some((h) => lower.includes(h))) {
+    return { code: 'RPC_TRANSIENT', message: msg, retryable: true };
+  }
+
+  return { code: 'RPC_PERMANENT', message: msg, retryable: false };
+}
diff --git a/packages/solana/src/index.ts b/packages/solana/src/index.ts
index 04f30c9..f0725bc 100644
--- a/packages/solana/src/index.ts
+++ b/packages/solana/src/index.ts
@@ -1,2 +1,4 @@
-// Solana instruction building + RPC boundary (no UI).
-export const SOLANA_PLACEHOLDER = true;
+export * from './types';
+export * from './config';
+export * from './errors';
+export * from './rpc';
diff --git a/packages/solana/src/rpc.ts b/packages/solana/src/rpc.ts
new file mode 100644
index 0000000..8c6cd8c
--- /dev/null
+++ b/packages/solana/src/rpc.ts
@@ -0,0 +1,21 @@
+import { Connection, type Commitment, type PublicKey } from '@solana/web3.js';
+import type { SolanaConfig } from './types';
+
+export type ReadonlyRpc = {
+  getSlot: () => Promise<number>;
+  getLatestBlockhash: () => Promise<{ blockhash: string; lastValidBlockHeight: number }>;
+  getAccountInfoExists: (pubkey: PublicKey) => Promise<boolean>;
+};
+
+export function createReadonlyRpc(config: SolanaConfig): ReadonlyRpc {
+  const connection = new Connection(config.rpcUrl, config.commitment as Commitment);
+
+  return {
+    getSlot: () => connection.getSlot(),
+    getLatestBlockhash: () => connection.getLatestBlockhash(),
+    async getAccountInfoExists(pubkey: PublicKey) {
+      const info = await connection.getAccountInfo(pubkey);
+      return Boolean(info);
+    },
+  };
+}
diff --git a/packages/solana/src/types.ts b/packages/solana/src/types.ts
new file mode 100644
index 0000000..f8d3dde
--- /dev/null
+++ b/packages/solana/src/types.ts
@@ -0,0 +1,24 @@
+export type CanonicalErrorCode =
+  | 'DATA_UNAVAILABLE'
+  | 'RPC_TRANSIENT'
+  | 'RPC_PERMANENT'
+  | 'INVALID_POSITION'
+  | 'NOT_SOL_USDC'
+  | 'ALREADY_EXECUTED_THIS_EPOCH'
+  | 'QUOTE_STALE'
+  | 'SIMULATION_FAILED'
+  | 'SLIPPAGE_EXCEEDED'
+  | 'INSUFFICIENT_FEE_BUFFER'
+  | 'BLOCKHASH_EXPIRED';
+
+export type SolanaConfig = {
+  rpcUrl: string;
+  cluster: 'devnet' | 'mainnet-beta' | 'localnet';
+  commitment: 'processed' | 'confirmed' | 'finalized';
+};
+
+export type NormalizedError = {
+  code: CanonicalErrorCode;
+  message: string;
+  retryable: boolean;
+};
diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
index 621b069..521a49a 100644
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -10,12 +10,21 @@ importers:
 
   apps/mobile:
     dependencies:
+      '@solana-mobile/mobile-wallet-adapter-protocol-web3js':
+        specifier: ^2.2.0
+        version: 2.2.5(@solana/wallet-adapter-base@0.9.27(@solana/web3.js@1.98.4(bufferutil@4.1.0)(typescript@5.9.3)(utf-8-validate@5.0.10)))(@solana/web3.js@1.98.4(bufferutil@4.1.0)(typescript@5.9.3)(utf-8-validate@5.0.10))(fastestsmallesttextencoderdecoder@1.0.22)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)(typescript@5.9.3)
+      '@solana/web3.js':
+        specifier: ^1.98.4
+        version: 1.98.4(bufferutil@4.1.0)(typescript@5.9.3)(utf-8-validate@5.0.10)
+      bs58:
+        specifier: ^6.0.0
+        version: 6.0.0
       expo:
         specifier: ~54.0.33
-        version: 54.0.33(@babel/core@7.29.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0)
+        version: 54.0.33(@babel/core@7.29.0)(bufferutil@4.1.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)(utf-8-validate@5.0.10)
       expo-status-bar:
         specifier: ~3.0.9
-        version: 3.0.9(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0)
+        version: 3.0.9(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)
       react:
         specifier: 19.1.0
         version: 19.1.0
@@ -24,7 +33,7 @@ importers:
         version: 19.1.0(react@19.1.0)
       react-native:
         specifier: 0.81.5
-        version: 0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0)
+        version: 0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10)
       react-native-web:
         specifier: ^0.21.2
         version: 0.21.2(react-dom@19.1.0(react@19.1.0))(react@19.1.0)
@@ -81,12 +90,25 @@ importers:
       typescript:
         specifier: ^5.9.3
         version: 5.9.3
+      vitest:
+        specifier: ^3.2.4
+        version: 3.2.4(@types/node@20.19.33)(jiti@2.6.1)(lightningcss@1.31.1)(terser@5.46.0)(yaml@2.8.2)
 
   packages/solana:
+    dependencies:
+      '@solana/web3.js':
+        specifier: ^1.98.4
+        version: 1.98.4(bufferutil@4.1.0)(typescript@5.9.3)(utf-8-validate@5.0.10)
     devDependencies:
+      '@types/node':
+        specifier: ^20.19.33
+        version: 20.19.33
       typescript:
         specifier: ^5.9.3
         version: 5.9.3
+      vitest:
+        specifier: ^3.2.4
+        version: 3.2.4(@types/node@20.19.33)(jiti@2.6.1)(lightningcss@1.31.1)(terser@5.46.0)(yaml@2.8.2)
 
 packages:
 
@@ -608,6 +630,162 @@ packages:
   '@emnapi/wasi-threads@1.1.0':
     resolution: {integrity: sha512-WI0DdZ8xFSbgMjR1sFsKABJ/C5OnRrjT06JXbZKexJGrDuPTzZdDYfFlsgcCXCyf+suG5QU2e/y1Wo2V/OapLQ==}
 
+  '@esbuild/aix-ppc64@0.27.3':
+    resolution: {integrity: sha512-9fJMTNFTWZMh5qwrBItuziu834eOCUcEqymSH7pY+zoMVEZg3gcPuBNxH1EvfVYe9h0x/Ptw8KBzv7qxb7l8dg==}
+    engines: {node: '>=18'}
+    cpu: [ppc64]
+    os: [aix]
+
+  '@esbuild/android-arm64@0.27.3':
+    resolution: {integrity: sha512-YdghPYUmj/FX2SYKJ0OZxf+iaKgMsKHVPF1MAq/P8WirnSpCStzKJFjOjzsW0QQ7oIAiccHdcqjbHmJxRb/dmg==}
+    engines: {node: '>=18'}
+    cpu: [arm64]
+    os: [android]
+
+  '@esbuild/android-arm@0.27.3':
+    resolution: {integrity: sha512-i5D1hPY7GIQmXlXhs2w8AWHhenb00+GxjxRncS2ZM7YNVGNfaMxgzSGuO8o8SJzRc/oZwU2bcScvVERk03QhzA==}
+    engines: {node: '>=18'}
+    cpu: [arm]
+    os: [android]
+
+  '@esbuild/android-x64@0.27.3':
+    resolution: {integrity: sha512-IN/0BNTkHtk8lkOM8JWAYFg4ORxBkZQf9zXiEOfERX/CzxW3Vg1ewAhU7QSWQpVIzTW+b8Xy+lGzdYXV6UZObQ==}
+    engines: {node: '>=18'}
+    cpu: [x64]
+    os: [android]
+
+  '@esbuild/darwin-arm64@0.27.3':
+    resolution: {integrity: sha512-Re491k7ByTVRy0t3EKWajdLIr0gz2kKKfzafkth4Q8A5n1xTHrkqZgLLjFEHVD+AXdUGgQMq+Godfq45mGpCKg==}
+    engines: {node: '>=18'}
+    cpu: [arm64]
+    os: [darwin]
+
+  '@esbuild/darwin-x64@0.27.3':
+    resolution: {integrity: sha512-vHk/hA7/1AckjGzRqi6wbo+jaShzRowYip6rt6q7VYEDX4LEy1pZfDpdxCBnGtl+A5zq8iXDcyuxwtv3hNtHFg==}
+    engines: {node: '>=18'}
+    cpu: [x64]
+    os: [darwin]
+
+  '@esbuild/freebsd-arm64@0.27.3':
+    resolution: {integrity: sha512-ipTYM2fjt3kQAYOvo6vcxJx3nBYAzPjgTCk7QEgZG8AUO3ydUhvelmhrbOheMnGOlaSFUoHXB6un+A7q4ygY9w==}
+    engines: {node: '>=18'}
+    cpu: [arm64]
+    os: [freebsd]
+
+  '@esbuild/freebsd-x64@0.27.3':
+    resolution: {integrity: sha512-dDk0X87T7mI6U3K9VjWtHOXqwAMJBNN2r7bejDsc+j03SEjtD9HrOl8gVFByeM0aJksoUuUVU9TBaZa2rgj0oA==}
+    engines: {node: '>=18'}
+    cpu: [x64]
+    os: [freebsd]
+
+  '@esbuild/linux-arm64@0.27.3':
+    resolution: {integrity: sha512-sZOuFz/xWnZ4KH3YfFrKCf1WyPZHakVzTiqji3WDc0BCl2kBwiJLCXpzLzUBLgmp4veFZdvN5ChW4Eq/8Fc2Fg==}
+    engines: {node: '>=18'}
+    cpu: [arm64]
+    os: [linux]
+
+  '@esbuild/linux-arm@0.27.3':
+    resolution: {integrity: sha512-s6nPv2QkSupJwLYyfS+gwdirm0ukyTFNl3KTgZEAiJDd+iHZcbTPPcWCcRYH+WlNbwChgH2QkE9NSlNrMT8Gfw==}
+    engines: {node: '>=18'}
+    cpu: [arm]
+    os: [linux]
+
+  '@esbuild/linux-ia32@0.27.3':
+    resolution: {integrity: sha512-yGlQYjdxtLdh0a3jHjuwOrxQjOZYD/C9PfdbgJJF3TIZWnm/tMd/RcNiLngiu4iwcBAOezdnSLAwQDPqTmtTYg==}
+    engines: {node: '>=18'}
+    cpu: [ia32]
+    os: [linux]
+
+  '@esbuild/linux-loong64@0.27.3':
+    resolution: {integrity: sha512-WO60Sn8ly3gtzhyjATDgieJNet/KqsDlX5nRC5Y3oTFcS1l0KWba+SEa9Ja1GfDqSF1z6hif/SkpQJbL63cgOA==}
+    engines: {node: '>=18'}
+    cpu: [loong64]
+    os: [linux]
+
+  '@esbuild/linux-mips64el@0.27.3':
+    resolution: {integrity: sha512-APsymYA6sGcZ4pD6k+UxbDjOFSvPWyZhjaiPyl/f79xKxwTnrn5QUnXR5prvetuaSMsb4jgeHewIDCIWljrSxw==}
+    engines: {node: '>=18'}
+    cpu: [mips64el]
+    os: [linux]
+
+  '@esbuild/linux-ppc64@0.27.3':
+    resolution: {integrity: sha512-eizBnTeBefojtDb9nSh4vvVQ3V9Qf9Df01PfawPcRzJH4gFSgrObw+LveUyDoKU3kxi5+9RJTCWlj4FjYXVPEA==}
+    engines: {node: '>=18'}
+    cpu: [ppc64]
+    os: [linux]
+
+  '@esbuild/linux-riscv64@0.27.3':
+    resolution: {integrity: sha512-3Emwh0r5wmfm3ssTWRQSyVhbOHvqegUDRd0WhmXKX2mkHJe1SFCMJhagUleMq+Uci34wLSipf8Lagt4LlpRFWQ==}
+    engines: {node: '>=18'}
+    cpu: [riscv64]
+    os: [linux]
+
+  '@esbuild/linux-s390x@0.27.3':
+    resolution: {integrity: sha512-pBHUx9LzXWBc7MFIEEL0yD/ZVtNgLytvx60gES28GcWMqil8ElCYR4kvbV2BDqsHOvVDRrOxGySBM9Fcv744hw==}
+    engines: {node: '>=18'}
+    cpu: [s390x]
+    os: [linux]
+
+  '@esbuild/linux-x64@0.27.3':
+    resolution: {integrity: sha512-Czi8yzXUWIQYAtL/2y6vogER8pvcsOsk5cpwL4Gk5nJqH5UZiVByIY8Eorm5R13gq+DQKYg0+JyQoytLQas4dA==}
+    engines: {node: '>=18'}
+    cpu: [x64]
+    os: [linux]
+
+  '@esbuild/netbsd-arm64@0.27.3':
+    resolution: {integrity: sha512-sDpk0RgmTCR/5HguIZa9n9u+HVKf40fbEUt+iTzSnCaGvY9kFP0YKBWZtJaraonFnqef5SlJ8/TiPAxzyS+UoA==}
+    engines: {node: '>=18'}
+    cpu: [arm64]
+    os: [netbsd]
+
+  '@esbuild/netbsd-x64@0.27.3':
+    resolution: {integrity: sha512-P14lFKJl/DdaE00LItAukUdZO5iqNH7+PjoBm+fLQjtxfcfFE20Xf5CrLsmZdq5LFFZzb5JMZ9grUwvtVYzjiA==}
+    engines: {node: '>=18'}
+    cpu: [x64]
+    os: [netbsd]
+
+  '@esbuild/openbsd-arm64@0.27.3':
+    resolution: {integrity: sha512-AIcMP77AvirGbRl/UZFTq5hjXK+2wC7qFRGoHSDrZ5v5b8DK/GYpXW3CPRL53NkvDqb9D+alBiC/dV0Fb7eJcw==}
+    engines: {node: '>=18'}
+    cpu: [arm64]
+    os: [openbsd]
+
+  '@esbuild/openbsd-x64@0.27.3':
+    resolution: {integrity: sha512-DnW2sRrBzA+YnE70LKqnM3P+z8vehfJWHXECbwBmH/CU51z6FiqTQTHFenPlHmo3a8UgpLyH3PT+87OViOh1AQ==}
+    engines: {node: '>=18'}
+    cpu: [x64]
+    os: [openbsd]
+
+  '@esbuild/openharmony-arm64@0.27.3':
+    resolution: {integrity: sha512-NinAEgr/etERPTsZJ7aEZQvvg/A6IsZG/LgZy+81wON2huV7SrK3e63dU0XhyZP4RKGyTm7aOgmQk0bGp0fy2g==}
+    engines: {node: '>=18'}
+    cpu: [arm64]
+    os: [openharmony]
+
+  '@esbuild/sunos-x64@0.27.3':
+    resolution: {integrity: sha512-PanZ+nEz+eWoBJ8/f8HKxTTD172SKwdXebZ0ndd953gt1HRBbhMsaNqjTyYLGLPdoWHy4zLU7bDVJztF5f3BHA==}
+    engines: {node: '>=18'}
+    cpu: [x64]
+    os: [sunos]
+
+  '@esbuild/win32-arm64@0.27.3':
+    resolution: {integrity: sha512-B2t59lWWYrbRDw/tjiWOuzSsFh1Y/E95ofKz7rIVYSQkUYBjfSgf6oeYPNWHToFRr2zx52JKApIcAS/D5TUBnA==}
+    engines: {node: '>=18'}
+    cpu: [arm64]
+    os: [win32]
+
+  '@esbuild/win32-ia32@0.27.3':
+    resolution: {integrity: sha512-QLKSFeXNS8+tHW7tZpMtjlNb7HKau0QDpwm49u0vUp9y1WOF+PEzkU84y9GqYaAVW8aH8f3GcBck26jh54cX4Q==}
+    engines: {node: '>=18'}
+    cpu: [ia32]
+    os: [win32]
+
+  '@esbuild/win32-x64@0.27.3':
+    resolution: {integrity: sha512-4uJGhsxuptu3OcpVAzli+/gWusVGwZZHTlS63hh++ehExkVT8SgiEf7/uC/PclrPPkLhZqGgCTjd0VWLo6xMqA==}
+    engines: {node: '>=18'}
+    cpu: [x64]
+    os: [win32]
+
   '@eslint-community/eslint-utils@4.9.1':
     resolution: {integrity: sha512-phrYmNiYppR7znFEdqgfWHXR6NCkZEK7hwWDHZUjit/2/U0r6XvkDl0SYnoM51Hq7FhCGdLDT6zxCCOY1hexsQ==}
     engines: {node: ^12.22.0 || ^14.17.0 || >=16.0.0}
@@ -1040,6 +1218,14 @@ packages:
     cpu: [x64]
     os: [win32]
 
+  '@noble/curves@1.9.7':
+    resolution: {integrity: sha512-gbKGcRUYIjA3/zCCNaWDciTMFI0dCkvou3TL8Zmy5Nc7sJ47a0jtOeZoTaMxkuqRo9cRhjOdZJXegxYE5FN/xw==}
+    engines: {node: ^14.21.3 || >=16}
+
+  '@noble/hashes@1.8.0':
+    resolution: {integrity: sha512-jCs9ldd7NwzpgXDIf6P3+NrHh9/sD6CQdxHyjQI+h/6rDNo88ypBxxz45UDuZHz9r3tNz7N/VInSVoVdtXEI4A==}
+    engines: {node: ^14.21.3 || >=16}
+
   '@nodelib/fs.scandir@2.1.5':
     resolution: {integrity: sha512-vq24Bq3ym5HEQm2NKCr3yXDwjc7vTsEThRDnkp2DK9p1uqLR+DHurm/NOTo0KG7HYHU7eppKZj3MyqYuMBf62g==}
     engines: {node: '>= 8'}
@@ -1121,6 +1307,144 @@ packages:
       '@types/react':
         optional: true
 
+  '@rollup/rollup-android-arm-eabi@4.58.0':
+    resolution: {integrity: sha512-mr0tmS/4FoVk1cnaeN244A/wjvGDNItZKR8hRhnmCzygyRXYtKF5jVDSIILR1U97CTzAYmbgIj/Dukg62ggG5w==}
+    cpu: [arm]
+    os: [android]
+
+  '@rollup/rollup-android-arm64@4.58.0':
+    resolution: {integrity: sha512-+s++dbp+/RTte62mQD9wLSbiMTV+xr/PeRJEc/sFZFSBRlHPNPVaf5FXlzAL77Mr8FtSfQqCN+I598M8U41ccQ==}
+    cpu: [arm64]
+    os: [android]
+
+  '@rollup/rollup-darwin-arm64@4.58.0':
+    resolution: {integrity: sha512-MFWBwTcYs0jZbINQBXHfSrpSQJq3IUOakcKPzfeSznONop14Pxuqa0Kg19GD0rNBMPQI2tFtu3UzapZpH0Uc1Q==}
+    cpu: [arm64]
+    os: [darwin]
+
+  '@rollup/rollup-darwin-x64@4.58.0':
+    resolution: {integrity: sha512-yiKJY7pj9c9JwzuKYLFaDZw5gma3fI9bkPEIyofvVfsPqjCWPglSHdpdwXpKGvDeYDms3Qal8qGMEHZ1M/4Udg==}
+    cpu: [x64]
+    os: [darwin]
+
+  '@rollup/rollup-freebsd-arm64@4.58.0':
+    resolution: {integrity: sha512-x97kCoBh5MOevpn/CNK9W1x8BEzO238541BGWBc315uOlN0AD/ifZ1msg+ZQB05Ux+VF6EcYqpiagfLJ8U3LvQ==}
+    cpu: [arm64]
+    os: [freebsd]
+
+  '@rollup/rollup-freebsd-x64@4.58.0':
+    resolution: {integrity: sha512-Aa8jPoZ6IQAG2eIrcXPpjRcMjROMFxCt1UYPZZtCxRV68WkuSigYtQ/7Zwrcr2IvtNJo7T2JfDXyMLxq5L4Jlg==}
+    cpu: [x64]
+    os: [freebsd]
+
+  '@rollup/rollup-linux-arm-gnueabihf@4.58.0':
+    resolution: {integrity: sha512-Ob8YgT5kD/lSIYW2Rcngs5kNB/44Q2RzBSPz9brf2WEtcGR7/f/E9HeHn1wYaAwKBni+bdXEwgHvUd0x12lQSA==}
+    cpu: [arm]
+    os: [linux]
+    libc: [glibc]
+
+  '@rollup/rollup-linux-arm-musleabihf@4.58.0':
+    resolution: {integrity: sha512-K+RI5oP1ceqoadvNt1FecL17Qtw/n9BgRSzxif3rTL2QlIu88ccvY+Y9nnHe/cmT5zbH9+bpiJuG1mGHRVwF4Q==}
+    cpu: [arm]
+    os: [linux]
+    libc: [musl]
+
+  '@rollup/rollup-linux-arm64-gnu@4.58.0':
+    resolution: {integrity: sha512-T+17JAsCKUjmbopcKepJjHWHXSjeW7O5PL7lEFaeQmiVyw4kkc5/lyYKzrv6ElWRX/MrEWfPiJWqbTvfIvjM1Q==}
+    cpu: [arm64]
+    os: [linux]
+    libc: [glibc]
+
+  '@rollup/rollup-linux-arm64-musl@4.58.0':
+    resolution: {integrity: sha512-cCePktb9+6R9itIJdeCFF9txPU7pQeEHB5AbHu/MKsfH/k70ZtOeq1k4YAtBv9Z7mmKI5/wOLYjQ+B9QdxR6LA==}
+    cpu: [arm64]
+    os: [linux]
+    libc: [musl]
+
+  '@rollup/rollup-linux-loong64-gnu@4.58.0':
+    resolution: {integrity: sha512-iekUaLkfliAsDl4/xSdoCJ1gnnIXvoNz85C8U8+ZxknM5pBStfZjeXgB8lXobDQvvPRCN8FPmmuTtH+z95HTmg==}
+    cpu: [loong64]
+    os: [linux]
+    libc: [glibc]
+
+  '@rollup/rollup-linux-loong64-musl@4.58.0':
+    resolution: {integrity: sha512-68ofRgJNl/jYJbxFjCKE7IwhbfxOl1muPN4KbIqAIe32lm22KmU7E8OPvyy68HTNkI2iV/c8y2kSPSm2mW/Q9Q==}
+    cpu: [loong64]
+    os: [linux]
+    libc: [musl]
+
+  '@rollup/rollup-linux-ppc64-gnu@4.58.0':
+    resolution: {integrity: sha512-dpz8vT0i+JqUKuSNPCP5SYyIV2Lh0sNL1+FhM7eLC457d5B9/BC3kDPp5BBftMmTNsBarcPcoz5UGSsnCiw4XQ==}
+    cpu: [ppc64]
+    os: [linux]
+    libc: [glibc]
+
+  '@rollup/rollup-linux-ppc64-musl@4.58.0':
+    resolution: {integrity: sha512-4gdkkf9UJ7tafnweBCR/mk4jf3Jfl0cKX9Np80t5i78kjIH0ZdezUv/JDI2VtruE5lunfACqftJ8dIMGN4oHew==}
+    cpu: [ppc64]
+    os: [linux]
+    libc: [musl]
+
+  '@rollup/rollup-linux-riscv64-gnu@4.58.0':
+    resolution: {integrity: sha512-YFS4vPnOkDTD/JriUeeZurFYoJhPf9GQQEF/v4lltp3mVcBmnsAdjEWhr2cjUCZzZNzxCG0HZOvJU44UGHSdzw==}
+    cpu: [riscv64]
+    os: [linux]
+    libc: [glibc]
+
+  '@rollup/rollup-linux-riscv64-musl@4.58.0':
+    resolution: {integrity: sha512-x2xgZlFne+QVNKV8b4wwaCS8pwq3y14zedZ5DqLzjdRITvreBk//4Knbcvm7+lWmms9V9qFp60MtUd0/t/PXPw==}
+    cpu: [riscv64]
+    os: [linux]
+    libc: [musl]
+
+  '@rollup/rollup-linux-s390x-gnu@4.58.0':
+    resolution: {integrity: sha512-jIhrujyn4UnWF8S+DHSkAkDEO3hLX0cjzxJZPLF80xFyzyUIYgSMRcYQ3+uqEoyDD2beGq7Dj7edi8OnJcS/hg==}
+    cpu: [s390x]
+    os: [linux]
+    libc: [glibc]
+
+  '@rollup/rollup-linux-x64-gnu@4.58.0':
+    resolution: {integrity: sha512-+410Srdoh78MKSJxTQ+hZ/Mx+ajd6RjjPwBPNd0R3J9FtL6ZA0GqiiyNjCO9In0IzZkCNrpGymSfn+kgyPQocg==}
+    cpu: [x64]
+    os: [linux]
+    libc: [glibc]
+
+  '@rollup/rollup-linux-x64-musl@4.58.0':
+    resolution: {integrity: sha512-ZjMyby5SICi227y1MTR3VYBpFTdZs823Rs/hpakufleBoufoOIB6jtm9FEoxn/cgO7l6PM2rCEl5Kre5vX0QrQ==}
+    cpu: [x64]
+    os: [linux]
+    libc: [musl]
+
+  '@rollup/rollup-openbsd-x64@4.58.0':
+    resolution: {integrity: sha512-ds4iwfYkSQ0k1nb8LTcyXw//ToHOnNTJtceySpL3fa7tc/AsE+UpUFphW126A6fKBGJD5dhRvg8zw1rvoGFxmw==}
+    cpu: [x64]
+    os: [openbsd]
+
+  '@rollup/rollup-openharmony-arm64@4.58.0':
+    resolution: {integrity: sha512-fd/zpJniln4ICdPkjWFhZYeY/bpnaN9pGa6ko+5WD38I0tTqk9lXMgXZg09MNdhpARngmxiCg0B0XUamNw/5BQ==}
+    cpu: [arm64]
+    os: [openharmony]
+
+  '@rollup/rollup-win32-arm64-msvc@4.58.0':
+    resolution: {integrity: sha512-YpG8dUOip7DCz3nr/JUfPbIUo+2d/dy++5bFzgi4ugOGBIox+qMbbqt/JoORwvI/C9Kn2tz6+Bieoqd5+B1CjA==}
+    cpu: [arm64]
+    os: [win32]
+
+  '@rollup/rollup-win32-ia32-msvc@4.58.0':
+    resolution: {integrity: sha512-b9DI8jpFQVh4hIXFr0/+N/TzLdpBIoPzjt0Rt4xJbW3mzguV3mduR9cNgiuFcuL/TeORejJhCWiAXe3E/6PxWA==}
+    cpu: [ia32]
+    os: [win32]
+
+  '@rollup/rollup-win32-x64-gnu@4.58.0':
+    resolution: {integrity: sha512-CSrVpmoRJFN06LL9xhkitkwUcTZtIotYAF5p6XOR2zW0Zz5mzb3IPpcoPhB02frzMHFNo1reQ9xSF5fFm3hUsQ==}
+    cpu: [x64]
+    os: [win32]
+
+  '@rollup/rollup-win32-x64-msvc@4.58.0':
+    resolution: {integrity: sha512-QFsBgQNTnh5K0t/sBsjJLq24YVqEIVkGpfN2VHsnN90soZyhaiA9UUHufcctVNL4ypJY0wrwad0wslx2KJQ1/w==}
+    cpu: [x64]
+    os: [win32]
+
   '@rtsao/scc@1.1.0':
     resolution: {integrity: sha512-zt6OdqaDoOnJ1ZYsCYGt9YmWzDXl4vQdKTyJev62gFhRGKdx7mcT54V9KIjg+d2wi9EXsPvAPKe7i7WjfVWB8g==}
 
@@ -1133,6 +1457,112 @@ packages:
   '@sinonjs/fake-timers@10.3.0':
     resolution: {integrity: sha512-V4BG07kuYSUkTCSBHG8G8TNhM+F19jXFWnQtzj+we8DrkpSBCee9Z3Ms8yiGer/dlmhe35/Xdgyo3/0rQKg7YA==}
 
+  '@solana-mobile/mobile-wallet-adapter-protocol-web3js@2.2.5':
+    resolution: {integrity: sha512-xfQl6Kee0ZXagUG5mpy+bMhQTNf2LAzF65m5SSgNJp47y/nP9GdXWi9blVH8IPP+QjF/+DnCtURaXS14bk3WJw==}
+    peerDependencies:
+      '@solana/web3.js': ^1.58.0
+
+  '@solana-mobile/mobile-wallet-adapter-protocol@2.2.5':
+    resolution: {integrity: sha512-kCI+0/umWm98M9g12ndpS56U6wBzq4XdhobCkDPF8qRDYX/iTU8CD+QMcalh7VgRT7GWEmySQvQdaugM0Chf0g==}
+    peerDependencies:
+      react-native: '>0.69'
+
+  '@solana/buffer-layout@4.0.1':
+    resolution: {integrity: sha512-E1ImOIAD1tBZFRdjeM4/pzTiTApC0AOBGwyAMS4fwIodCWArzJ3DWdoh8cKxeFM2fElkxBh2Aqts1BPC373rHA==}
+    engines: {node: '>=5.10'}
+
+  '@solana/codecs-core@2.3.0':
+    resolution: {integrity: sha512-oG+VZzN6YhBHIoSKgS5ESM9VIGzhWjEHEGNPSibiDTxFhsFWxNaz8LbMDPjBUE69r9wmdGLkrQ+wVPbnJcZPvw==}
+    engines: {node: '>=20.18.0'}
+    peerDependencies:
+      typescript: '>=5.3.3'
+
+  '@solana/codecs-core@4.0.0':
+    resolution: {integrity: sha512-28kNUsyIlhU3MO3/7ZLDqeJf2YAm32B4tnTjl5A9HrbBqsTZ+upT/RzxZGP1MMm7jnPuIKCMwmTpsyqyR6IUpw==}
+    engines: {node: '>=20.18.0'}
+    peerDependencies:
+      typescript: '>=5.3.3'
+
+  '@solana/codecs-numbers@2.3.0':
+    resolution: {integrity: sha512-jFvvwKJKffvG7Iz9dmN51OGB7JBcy2CJ6Xf3NqD/VP90xak66m/Lg48T01u5IQ/hc15mChVHiBm+HHuOFDUrQg==}
+    engines: {node: '>=20.18.0'}
+    peerDependencies:
+      typescript: '>=5.3.3'
+
+  '@solana/codecs-numbers@4.0.0':
+    resolution: {integrity: sha512-z9zpjtcwzqT9rbkKVZpkWB5/0V7+6YRKs6BccHkGJlaDx8Pe/+XOvPi2rEdXPqrPd9QWb5Xp1iBfcgaDMyiOiA==}
+    engines: {node: '>=20.18.0'}
+    peerDependencies:
+      typescript: '>=5.3.3'
+
+  '@solana/codecs-strings@4.0.0':
+    resolution: {integrity: sha512-XvyD+sQ1zyA0amfxbpoFZsucLoe+yASQtDiLUGMDg5TZ82IHE3B7n82jE8d8cTAqi0HgqQiwU13snPhvg1O0Ow==}
+    engines: {node: '>=20.18.0'}
+    peerDependencies:
+      fastestsmallesttextencoderdecoder: ^1.0.22
+      typescript: '>=5.3.3'
+
+  '@solana/errors@2.3.0':
+    resolution: {integrity: sha512-66RI9MAbwYV0UtP7kGcTBVLxJgUxoZGm8Fbc0ah+lGiAw17Gugco6+9GrJCV83VyF2mDWyYnYM9qdI3yjgpnaQ==}
+    engines: {node: '>=20.18.0'}
+    hasBin: true
+    peerDependencies:
+      typescript: '>=5.3.3'
+
+  '@solana/errors@4.0.0':
+    resolution: {integrity: sha512-3YEtvcMvtcnTl4HahqLt0VnaGVf7vVWOnt6/uPky5e0qV6BlxDSbGkbBzttNjxLXHognV0AQi3pjvrtfUnZmbg==}
+    engines: {node: '>=20.18.0'}
+    hasBin: true
+    peerDependencies:
+      typescript: '>=5.3.3'
+
+  '@solana/wallet-adapter-base@0.9.27':
+    resolution: {integrity: sha512-kXjeNfNFVs/NE9GPmysBRKQ/nf+foSaq3kfVSeMcO/iVgigyRmB551OjU3WyAolLG/1jeEfKLqF9fKwMCRkUqg==}
+    engines: {node: '>=20'}
+    peerDependencies:
+      '@solana/web3.js': ^1.98.0
+
+  '@solana/wallet-standard-chains@1.1.1':
+    resolution: {integrity: sha512-Us3TgL4eMVoVWhuC4UrePlYnpWN+lwteCBlhZDUhFZBJ5UMGh94mYPXno3Ho7+iHPYRtuCi/ePvPcYBqCGuBOw==}
+    engines: {node: '>=16'}
+
+  '@solana/wallet-standard-core@1.1.2':
+    resolution: {integrity: sha512-FaSmnVsIHkHhYlH8XX0Y4TYS+ebM+scW7ZeDkdXo3GiKge61Z34MfBPinZSUMV08hCtzxxqH2ydeU9+q/KDrLA==}
+    engines: {node: '>=16'}
+
+  '@solana/wallet-standard-features@1.3.0':
+    resolution: {integrity: sha512-ZhpZtD+4VArf6RPitsVExvgkF+nGghd1rzPjd97GmBximpnt1rsUxMOEyoIEuH3XBxPyNB6Us7ha7RHWQR+abg==}
+    engines: {node: '>=16'}
+
+  '@solana/wallet-standard-util@1.1.2':
+    resolution: {integrity: sha512-rUXFNP4OY81Ddq7qOjQV4Kmkozx4wjYAxljvyrqPx8Ycz0FYChG/hQVWqvgpK3sPsEaO/7ABG1NOACsyAKWNOA==}
+    engines: {node: '>=16'}
+
+  '@solana/wallet-standard-wallet-adapter-base@1.1.4':
+    resolution: {integrity: sha512-Q2Rie9YaidyFA4UxcUIxUsvynW+/gE2noj/Wmk+IOwDwlVrJUAXCvFaCNsPDSyKoiYEKxkSnlG13OA1v08G4iw==}
+    engines: {node: '>=16'}
+    peerDependencies:
+      '@solana/web3.js': ^1.98.0
+      bs58: ^6.0.0
+
+  '@solana/wallet-standard-wallet-adapter-react@1.1.4':
+    resolution: {integrity: sha512-xa4KVmPgB7bTiWo4U7lg0N6dVUtt2I2WhEnKlIv0jdihNvtyhOjCKMjucWet6KAVhir6I/mSWrJk1U9SvVvhCg==}
+    engines: {node: '>=16'}
+    peerDependencies:
+      '@solana/wallet-adapter-base': '*'
+      react: '*'
+
+  '@solana/wallet-standard-wallet-adapter@1.1.4':
+    resolution: {integrity: sha512-YSBrxwov4irg2hx9gcmM4VTew3ofNnkqsXQ42JwcS6ykF1P1ecVY8JCbrv75Nwe6UodnqeoZRbN7n/p3awtjNQ==}
+    engines: {node: '>=16'}
+
+  '@solana/wallet-standard@1.1.4':
+    resolution: {integrity: sha512-NF+MI5tOxyvfTU4A+O5idh/gJFmjm52bMwsPpFGRSL79GECSN0XLmpVOO/jqTKJgac2uIeYDpQw/eMaQuWuUXw==}
+    engines: {node: '>=16'}
+
+  '@solana/web3.js@1.98.4':
+    resolution: {integrity: sha512-vv9lfnvjUsRiq//+j5pBdXig0IQdtzA0BRZ3bXEP4KaIyF1CcaydWqgyzQgfZMNIsWNWmG+AUHwPy4AHOD6gpw==}
+
   '@swc/helpers@0.5.15':
     resolution: {integrity: sha512-JQ5TuMi45Owi4/BIMAJBoSQoOJu12oOk/gADqlcUL9JEdHB8vyjUSsxqeNXnmXHjYKMi2WcYtezGEEhqUI/E2g==}
 
@@ -1243,6 +1673,15 @@ packages:
   '@types/babel__traverse@7.28.0':
     resolution: {integrity: sha512-8PvcXf70gTDZBgt9ptxJ8elBeBjcLOAcOtoO/mPJjtji1+CdGbHgm77om1GrsPxsiE+uXIpNSK64UYaIwQXd4Q==}
 
+  '@types/chai@5.2.3':
+    resolution: {integrity: sha512-Mw558oeA9fFbv65/y4mHtXDs9bPnFMZAL/jxdPFUpOHHIXX91mcgEHbS5Lahr+pwZFR8A7GQleRWeI6cGFC2UA==}
+
+  '@types/connect@3.4.38':
+    resolution: {integrity: sha512-K6uROf1LD88uDQqJCktA4yzL1YYAK6NgfsI0v/mTgyPKWsX1CnJ0XPSDhViejru1GcRkLWb8RlzFYJRqGUbaug==}
+
+  '@types/deep-eql@4.0.2':
+    resolution: {integrity: sha512-c9h9dVVMigMPc4bwTvC5dxqtqJZwQPePsWjPlpSOnojbor6pGqdk541lfA7AqFQr5pB1BRdq0juY9db81BwyFw==}
+
   '@types/estree@1.0.8':
     resolution: {integrity: sha512-dWHzHa2WqEXI/O1E9OjrocMTKJl2mSrEolh1Iomrv6U+JuNwaHXsXx9bLu5gG7BUWFIN0skIQJQ/L1rIex4X6w==}
 
@@ -1264,6 +1703,9 @@ packages:
   '@types/json5@0.0.29':
     resolution: {integrity: sha512-dRLjCWHYg4oaA77cxO64oO+7JwCwnIzkZPdrrC71jQmQtlhM556pwKo5bUzqvZndkVbeFLIIi+9TC40JNF5hNQ==}
 
+  '@types/node@12.20.55':
+    resolution: {integrity: sha512-J8xLz7q2OFulZ2cyGTLE1TbbZcjpno7FaN6zdJNrgAdrJ+DZzh/uFR6YrTb4C+nXakvud8Q4+rbhoIWlYQbUFQ==}
+
   '@types/node@20.19.33':
     resolution: {integrity: sha512-Rs1bVAIdBs5gbTIKza/tgpMuG1k3U/UMJLWecIMxNdJFDMzcM5LOiLVRYh3PilWEYDIeUDv7bpiHPLPsbydGcw==}
 
@@ -1281,6 +1723,15 @@ packages:
   '@types/stack-utils@2.0.3':
     resolution: {integrity: sha512-9aEbYZ3TbYMznPdcdr3SmIrLXwC/AKZXQeCf9Pgao5CKb8CyHuEX5jzWPTkvregvhRJHcpRO6BFoGW9ycaOkYw==}
 
+  '@types/uuid@8.3.4':
+    resolution: {integrity: sha512-c/I8ZRb51j+pYGAu5CrFMRxqZ2ke4y2grEBO5AUjgSkSk+qT2Ea+OdWElz/OiMf5MNpn2b17kuVBwZLQJXzihw==}
+
+  '@types/ws@7.4.7':
+    resolution: {integrity: sha512-JQbbmxZTZehdc2iszGKs5oC3NFnjeay7mtAWrdt7qNtAVK0g19muApzAy4bm9byz79xa2ZnO/BOBC2R8RC5Lww==}
+
+  '@types/ws@8.18.1':
+    resolution: {integrity: sha512-ThVF6DCVhA8kUGy+aazFQ4kXQ7E1Ty7A3ypFOe0IcJV8O/M511G99AW24irKrW56Wt44yG9+ij8FaqoBGkuBXg==}
+
   '@types/yargs-parser@21.0.3':
     resolution: {integrity: sha512-I4q9QU9MQv4oEOz4tAHJtNz1cwuLxn2F3xcc2iV5WdqLPpUnj30aUuxt1mAxYTG+oe8CZMV/+6rU4S4gRDzqtQ==}
 
@@ -1460,6 +1911,60 @@ packages:
     peerDependencies:
       '@urql/core': ^5.0.0
 
+  '@vitest/expect@3.2.4':
+    resolution: {integrity: sha512-Io0yyORnB6sikFlt8QW5K7slY4OjqNX9jmJQ02QDda8lyM6B5oNgVWoSoKPac8/kgnCUzuHQKrSLtu/uOqqrig==}
+
+  '@vitest/mocker@3.2.4':
+    resolution: {integrity: sha512-46ryTE9RZO/rfDd7pEqFl7etuyzekzEhUbTW3BvmeO/BcCMEgq59BKhek3dXDWgAj4oMK6OZi+vRr1wPW6qjEQ==}
+    peerDependencies:
+      msw: ^2.4.9
+      vite: ^5.0.0 || ^6.0.0 || ^7.0.0-0
+    peerDependenciesMeta:
+      msw:
+        optional: true
+      vite:
+        optional: true
+
+  '@vitest/pretty-format@3.2.4':
+    resolution: {integrity: sha512-IVNZik8IVRJRTr9fxlitMKeJeXFFFN0JaB9PHPGQ8NKQbGpfjlTx9zO4RefN8gp7eqjNy8nyK3NZmBzOPeIxtA==}
+
+  '@vitest/runner@3.2.4':
+    resolution: {integrity: sha512-oukfKT9Mk41LreEW09vt45f8wx7DordoWUZMYdY/cyAk7w5TWkTRCNZYF7sX7n2wB7jyGAl74OxgwhPgKaqDMQ==}
+
+  '@vitest/snapshot@3.2.4':
+    resolution: {integrity: sha512-dEYtS7qQP2CjU27QBC5oUOxLE/v5eLkGqPE0ZKEIDGMs4vKWe7IjgLOeauHsR0D5YuuycGRO5oSRXnwnmA78fQ==}
+
+  '@vitest/spy@3.2.4':
+    resolution: {integrity: sha512-vAfasCOe6AIK70iP5UD11Ac4siNUNJ9i/9PZ3NKx07sG6sUxeag1LWdNrMWeKKYBLlzuK+Gn65Yd5nyL6ds+nw==}
+
+  '@vitest/utils@3.2.4':
+    resolution: {integrity: sha512-fB2V0JFrQSMsCo9HiSq3Ezpdv4iYaXRG1Sx8edX3MwxfyNn83mKiGzOcH+Fkxt4MHxr3y42fQi1oeAInqgX2QA==}
+
+  '@wallet-standard/app@1.1.0':
+    resolution: {integrity: sha512-3CijvrO9utx598kjr45hTbbeeykQrQfKmSnxeWOgU25TOEpvcipD/bYDQWIqUv1Oc6KK4YStokSMu/FBNecGUQ==}
+    engines: {node: '>=16'}
+
+  '@wallet-standard/base@1.1.0':
+    resolution: {integrity: sha512-DJDQhjKmSNVLKWItoKThJS+CsJQjR9AOBOirBVT1F9YpRyC9oYHE+ZnSf8y8bxUphtKqdQMPVQ2mHohYdRvDVQ==}
+    engines: {node: '>=16'}
+
+  '@wallet-standard/core@1.1.1':
+    resolution: {integrity: sha512-5Xmjc6+Oe0hcPfVc5n8F77NVLwx1JVAoCVgQpLyv/43/bhtIif+Gx3WUrDlaSDoM8i2kA2xd6YoFbHCxs+e0zA==}
+    engines: {node: '>=16'}
+
+  '@wallet-standard/errors@0.1.1':
+    resolution: {integrity: sha512-V8Ju1Wvol8i/VDyQOHhjhxmMVwmKiwyxUZBnHhtiPZJTWY0U/Shb2iEWyGngYEbAkp2sGTmEeNX1tVyGR7PqNw==}
+    engines: {node: '>=16'}
+    hasBin: true
+
+  '@wallet-standard/features@1.1.0':
+    resolution: {integrity: sha512-hiEivWNztx73s+7iLxsuD1sOJ28xtRix58W7Xnz4XzzA/pF0+aicnWgjOdA10doVDEDZdUuZCIIqG96SFNlDUg==}
+    engines: {node: '>=16'}
+
+  '@wallet-standard/wallet@1.1.0':
+    resolution: {integrity: sha512-Gt8TnSlDZpAl+RWOOAB/kuvC7RpcdWAlFbHNoi4gsXsfaWa1QCT6LBcfIYTPdOZC9OVZUDwqGuGAcqZejDmHjg==}
+    engines: {node: '>=16'}
+
   '@xmldom/xmldom@0.8.11':
     resolution: {integrity: sha512-cQzWCtO6C8TQiYl1ruKNn2U6Ao4o4WBBcbL61yJl84x+j5sOWWFU9X7DpND8XZG3daDppSsigMdfAIl2upQBRw==}
     engines: {node: '>=10.0.0'}
@@ -1490,6 +1995,10 @@ packages:
     resolution: {integrity: sha512-MnA+YT8fwfJPgBx3m60MNqakm30XOkyIoH1y6huTQvC0PwZG7ki8NacLBcrPbNoo8vEZy7Jpuk7+jMO+CUovTQ==}
     engines: {node: '>= 14'}
 
+  agentkeepalive@4.6.0:
+    resolution: {integrity: sha512-kja8j7PjmncONqaTsB8fQ+wE2mSU2DJ9D4XKoJ5PFWIdRMa6SLSN1ff4mOr4jCbfRSsxR4keIiySJU0N9T5hIQ==}
+    engines: {node: '>= 8.0.0'}
+
   ajv@6.14.0:
     resolution: {integrity: sha512-IWrosm/yrn43eiKqkfkHis7QioDleaXQHdDVPKg0FSwwd/DuvyX79TZnFOnYpB7dcsFAMmtFztZuXPDvSePkFw==}
 
@@ -1575,6 +2084,10 @@ packages:
   asap@2.0.6:
     resolution: {integrity: sha512-BSHWgDSAiKs50o2Re8ppvp3seVHXSRM44cdSsT9FfNEUUZLOGWVCsiWaRPWM1Znn+mqZ1OfVZ3z3DWEzSp7hRA==}
 
+  assertion-error@2.0.1:
+    resolution: {integrity: sha512-Izi8RQcffqCeNVgFigKli1ssklIbpHnCYc6AknXGYoB6grJqyeby7jv12JUQgmTAnIDnbck1uxksT4dzN3PWBA==}
+    engines: {node: '>=12'}
+
   ast-types-flow@0.0.8:
     resolution: {integrity: sha512-OH/2E5Fg20h2aPrbe+QL8JZQFko0YZaF+j4mnQ7BGhfavO7OpSLa8a0y9sBwomHdSbkhTS8TQNayBfnW5DwbvQ==}
 
@@ -1668,6 +2181,15 @@ packages:
     resolution: {integrity: sha512-1pHv8LX9CpKut1Zp4EXey7Z8OfH11ONNH6Dhi2WDUt31VVZFXZzKwXcysBgqSumFCmR+0dqjMK5v5JiFHzi0+g==}
     engines: {node: 20 || >=22}
 
+  base-x@3.0.11:
+    resolution: {integrity: sha512-xz7wQ8xDhdyP7tQxwdteLYeFfS68tSMNCZ/Y37WJ4bhGfKPpqEIlmIyueQHqOyoPhE6xNUqjzRr8ra0eF9VRvA==}
+
+  base-x@4.0.1:
+    resolution: {integrity: sha512-uAZ8x6r6S3aUM9rbHGVOIsR15U/ZSc82b3ymnCPsT45Gk1DDvhDPdIgB5MrhirZWt+5K0EEPQH985kNqZgNPFw==}
+
+  base-x@5.0.1:
+    resolution: {integrity: sha512-M7uio8Zt++eg3jPj+rHMfCC+IuygQHHCOU+IYsVtik6FWjuYpVt/+MRKcgsAMHh8mMFAwnB+Bs+mTrFiXjMzKg==}
+
   base64-js@1.5.1:
     resolution: {integrity: sha512-AKpaYlHn8t4SVbOHCy+b5+KKgvR4vrsD8vbvrbiQJps7fKDTkjkDry6ji0rUJjC0kzbNePLwzxq8iypo41qeWA==}
 
@@ -1684,6 +2206,12 @@ packages:
     resolution: {integrity: sha512-QxD8cf2eVqJOOz63z6JIN9BzvVs/dlySa5HGSBH5xtR8dPteIRQnBxxKqkNTiT6jbDTF6jAfrd4oMcND9RGbQg==}
     engines: {node: '>=0.6'}
 
+  bn.js@5.2.3:
+    resolution: {integrity: sha512-EAcmnPkxpntVL+DS7bO1zhcZNvCkxqtkd0ZY53h06GNQ3DEkkGZ/gKgmDv6DdZQGj9BgfSPKtJJ7Dp1GPP8f7w==}
+
+  borsh@0.7.0:
+    resolution: {integrity: sha512-CLCsZGIBCFnPtkNnieW/a8wmreDmfUtjU2m9yHrzPXIlNbqVs0AQrSatSG6vdNYUqdc83tkQi2eHfF98ubzQLA==}
+
   bplist-creator@0.1.0:
     resolution: {integrity: sha512-sXaHZicyEEmY86WyueLTQesbeoH/mquvarJaQNbjuOQO+7gbFcDEWqKmcWA4cOTLzFlfgvkiVxolk1k5bBIpmg==}
 
@@ -1714,6 +2242,15 @@ packages:
     engines: {node: ^6 || ^7 || ^8 || ^9 || ^10 || ^11 || ^12 || >=13.7}
     hasBin: true
 
+  bs58@4.0.1:
+    resolution: {integrity: sha512-Ok3Wdf5vOIlBrgCvTq96gBkJw+JUEzdBgyaza5HLtPm7yTHkjRy8+JzNyHF7BHa0bNWOQIp3m5YF0nnFcOIKLw==}
+
+  bs58@5.0.0:
+    resolution: {integrity: sha512-r+ihvQJvahgYT50JD05dyJNKlmmSlMoOGwn1lCcEzanPglg7TxYjioQUYehQ9mAR/+hOSd2jRc/Z2y5UxBymvQ==}
+
+  bs58@6.0.0:
+    resolution: {integrity: sha512-PD0wEnEYg6ijszw/u8s+iI3H17cTymlrwkKhDhPZq+Sokl3AU4htyBFTjAeNAlCCmg0f53g6ih3jATyCKftTfw==}
+
   bser@2.1.1:
     resolution: {integrity: sha512-gQxTNE/GAfIIrmHLUE3oJyp5FO6HRBfhjnw4/wMmA63ZGDJnWBmgY/lyQBpnDUkGmAhbSe39tx2d/iTOAfglwQ==}
 
@@ -1723,10 +2260,21 @@ packages:
   buffer@5.7.1:
     resolution: {integrity: sha512-EHcyIPBQ4BSGlvjB16k5KgAJ27CIsHY/2JBmCRReo48y9rQ3MaUzWX3KVlBa4U7MyX02HdVj0K7C3WaB3ju7FQ==}
 
+  buffer@6.0.3:
+    resolution: {integrity: sha512-FTiCpNxtwiZZHEZbcbTIcZjERVICn9yq/pDFkTl95/AxzD1naBctN7YO68riM/gLSDY7sdrMby8hofADYuuqOA==}
+
+  bufferutil@4.1.0:
+    resolution: {integrity: sha512-ZMANVnAixE6AWWnPzlW2KpUrxhm9woycYvPOo67jWHyFowASTEd9s+QN1EIMsSDtwhIxN4sWE1jotpuDUIgyIw==}
+    engines: {node: '>=6.14.2'}
+
   bytes@3.1.2:
     resolution: {integrity: sha512-/Nf7TyzTx6S3yRJObOAV7956r8cr2+Oj8AC5dt8wSP3BQAoeX58NoHyCU8P8zGkNXStjTSi6fzO6F0pBdcYbEg==}
     engines: {node: '>= 0.8'}
 
+  cac@6.7.14:
+    resolution: {integrity: sha512-b6Ilus+c3RrdDk+JhLKUAQfzzgLEPy6wcXqS7f/xe1EETvsDP6GORG7SFuOs6cID5YkqchW/LXZbX5bc8j7ZcQ==}
+    engines: {node: '>=8'}
+
   call-bind-apply-helpers@1.0.2:
     resolution: {integrity: sha512-Sp1ablJ0ivDkSzjcaJdxEunN5/XvksFJ2sMBFfq6x0ryhQV/2b/KwFe21cMpmHtPOSij8K99/wSfoEuTObmuMQ==}
     engines: {node: '>= 0.4'}
@@ -1754,6 +2302,10 @@ packages:
   caniuse-lite@1.0.30001770:
     resolution: {integrity: sha512-x/2CLQ1jHENRbHg5PSId2sXq1CIO1CISvwWAj027ltMVG2UNgW+w9oH2+HzgEIRFembL8bUlXtfbBHR1fCg2xw==}
 
+  chai@5.3.3:
+    resolution: {integrity: sha512-4zNhdJD/iOjSH0A05ea+Ke6MU5mmpQcbQsSOkgdaUMJ9zTlDTD/GYlwohmIE2u0gaxHYiVHEn1Fw9mZ/ktJWgw==}
+    engines: {node: '>=18'}
+
   chalk@2.4.2:
     resolution: {integrity: sha512-Mti+f9lpJNcwF4tWV8/OrTTtF1gZi+f8FqlyAdouralcFWFQWF2+NgCHShjkCb+IFBLq9buZwE1xckQU4peSuQ==}
     engines: {node: '>=4'}
@@ -1762,6 +2314,14 @@ packages:
     resolution: {integrity: sha512-oKnbhFyRIXpUuez8iBMmyEa4nbj4IOQyuhc/wy9kY7/WVPcwIO9VA668Pu8RkO7+0G76SLROeyw9CpQ061i4mA==}
     engines: {node: '>=10'}
 
+  chalk@5.6.2:
+    resolution: {integrity: sha512-7NzBL0rN6fMUW+f7A6Io4h40qQlG+xGmtMxfbnH/K7TAtt8JQWVQK+6g0UXKMeVJoyV5EkkNsErQ8pVD3bLHbA==}
+    engines: {node: ^12.17.0 || ^14.13 || >=16.0.0}
+
+  check-error@2.1.3:
+    resolution: {integrity: sha512-PAJdDJusoxnwm1VwW07VWwUN1sl7smmC3OKggvndJFadxxDRyFJBX/ggnu/KE4kQAB7a3Dp8f/YXC1FlUprWmA==}
+    engines: {node: '>= 16'}
+
   chownr@3.0.0:
     resolution: {integrity: sha512-+IxzY9BZOQd/XuYPRmrvEVjF/nqj5kgT4kEq7VofrDoM1MxoRjEWkrCC3EtLi59TVawxTAn+orJwFQcrqEN1+g==}
     engines: {node: '>=18'}
@@ -1817,6 +2377,18 @@ packages:
     resolution: {integrity: sha512-Vw8qHK3bZM9y/P10u3Vib8o/DdkvA2OtPtZvD871QKjy74Wj1WSKFILMPRPSdUSx5RFK1arlJzEtA4PkFgnbuA==}
     engines: {node: '>=18'}
 
+  commander@13.1.0:
+    resolution: {integrity: sha512-/rFeCpNJQbhSZjGVwO9RFV3xPqbnERS8MmIQzCtD/zl6gpJuV/bMLuN92oG3F7d8oDEHHRrujSXNUr8fpjntKw==}
+    engines: {node: '>=18'}
+
+  commander@14.0.1:
+    resolution: {integrity: sha512-2JkV3gUZUVrbNA+1sjBOYLsMZ5cEEl8GTFP2a4AVz5hvasAMCQ1D2l2le/cX+pV4N6ZU17zjUahLpIXRrnWL8A==}
+    engines: {node: '>=20'}
+
+  commander@14.0.3:
+    resolution: {integrity: sha512-H+y0Jo/T1RZ9qPP4Eh1pkcQcLRglraJaSLoyOtHxu6AapkjWVCy2Sit1QQ4x3Dng8qDlSsZEet7g5Pq06MvTgw==}
+    engines: {node: '>=20'}
+
   commander@2.20.3:
     resolution: {integrity: sha512-GpVkmM8vF2vQUkj2LvZmD35JxeJOLCwJ9cUkugyk2nuhbv3+mJvpLYYt+0+USMxE+oj+ey/lJEnhZw75x/OMcQ==}
 
@@ -1906,6 +2478,10 @@ packages:
       supports-color:
         optional: true
 
+  deep-eql@5.0.2:
+    resolution: {integrity: sha512-h5k/5U50IJJFpzfL6nO9jaaumfjO/f2NjK/oYB2Djzm4p9L+3T9qWpZqZ2hAbLPuuYq9wrU08WQyBTL5GbPk5Q==}
+    engines: {node: '>=6'}
+
   deep-extend@0.6.0:
     resolution: {integrity: sha512-LOHxIOaPYdHlJRtCQfDIVZtfw/ufM8+rVj649RIHzcm/vGwQRXFt6OPqIFWsm2XEMrNIEtWR64sY1LEKD2vAOA==}
     engines: {node: '>=4.0.0'}
@@ -1932,6 +2508,10 @@ packages:
     resolution: {integrity: sha512-8QmQKqEASLd5nx0U1B1okLElbUuuttJ/AnYmRXbbbGDWh6uS208EjD4Xqq/I9wK7u0v6O08XhTWnt5XtEbR6Dg==}
     engines: {node: '>= 0.4'}
 
+  delay@5.0.0:
+    resolution: {integrity: sha512-ReEBKkIfe4ya47wlPYf/gu5ib6yUG0/Aez0JQZQz94kiWtRQvZIQbTiehsnwHvLSWJnQdhVeqYue7Id1dKr0qw==}
+    engines: {node: '>=10'}
+
   depd@2.0.0:
     resolution: {integrity: sha512-g7nH6P6dyDioJogAAGprGpCtVImJhpPk/roCzdb3fIh61/s/nPsfR6onyMwkCAR/OlC3yBC0lESvUoQEAssIrw==}
     engines: {node: '>= 0.8'}
@@ -2007,6 +2587,9 @@ packages:
     resolution: {integrity: sha512-BrUQ0cPTB/IwXj23HtwHjS9n7O4h9FX94b4xc5zlTHxeLgTAdzYUDyy6KdExAl9lbN5rtfe44xpjpmj9grxs5w==}
     engines: {node: '>= 0.4'}
 
+  es-module-lexer@1.7.0:
+    resolution: {integrity: sha512-jEQoCwk8hyb2AZziIOLhDqpm5+2ww5uIE6lkO/6jcOCusfk6LhMHpXXfBLXTZ7Ydyt0j4VoUQv6uGNYbdW+kBA==}
+
   es-object-atoms@1.1.1:
     resolution: {integrity: sha512-FGgH2h8zKNim9ljj7dankFPcICIK9Cp5bm+c2gQSYePhpaG5+esrLODihIorn+Pe6FGJzWhXQotPv73jTaldXA==}
     engines: {node: '>= 0.4'}
@@ -2023,6 +2606,17 @@ packages:
     resolution: {integrity: sha512-w+5mJ3GuFL+NjVtJlvydShqE1eN3h3PbI7/5LAsYJP/2qtuMXjfL2LpHSRqo4b4eSF5K/DH1JXKUAHSB2UW50g==}
     engines: {node: '>= 0.4'}
 
+  es6-promise@4.2.8:
+    resolution: {integrity: sha512-HJDGx5daxeIvxdBxvG2cb9g4tEvwIk3i8+nhX0yGrYmZUzbkdg8QbDevheDB8gd0//uPj4c1EQua8Q+MViT0/w==}
+
+  es6-promisify@5.0.0:
+    resolution: {integrity: sha512-C+d6UdsYDk0lMebHNR4S2NybQMMngAOnOwYBQjTOiv0MkoJMP0Myw2mgpDLBcpfCmRLxyFqYhS/CfOENq4SJhQ==}
+
+  esbuild@0.27.3:
+    resolution: {integrity: sha512-8VwMnyGCONIs6cWue2IdpHxHnAjzxnw2Zr7MkVxB2vjmQ2ivqGFb4LEG3SMnv0Gb2F/G/2yA8zUaiL1gywDCCg==}
+    engines: {node: '>=18'}
+    hasBin: true
+
   escalade@3.2.0:
     resolution: {integrity: sha512-WUj2qlxaQtO4g6Pq5c29GTcWGDyd8itL8zTlipgECz3JesAiiOKotd8JU6otB3PACgG6xkJUyVhboMS+bje/jA==}
     engines: {node: '>=6'}
@@ -2180,6 +2774,9 @@ packages:
     resolution: {integrity: sha512-MMdARuVEQziNTeJD8DgMqmhwR11BRQ/cBP+pLtYdSTnf3MIO8fFeiINEbX36ZdNlfU/7A9f3gUw49B3oQsvwBA==}
     engines: {node: '>=4.0'}
 
+  estree-walker@3.0.3:
+    resolution: {integrity: sha512-7RUKfXgSMMkzt6ZuXmqapOurLGPPfgj6l9uRZ7lRGolvk0y2yocc35LdcxKC5PQZdn2DMqioAQ2NoWcrTKmm6g==}
+
   esutils@2.0.3:
     resolution: {integrity: sha512-kVscqXk4OCp68SZ0dkgEKVi6/8ij300KBWTJq32P/dYeWTSwK41WyTxalN1eRmA5Z9UU/LX9D7FWSmV9SAYx6g==}
     engines: {node: '>=0.10.0'}
@@ -2192,9 +2789,16 @@ packages:
     resolution: {integrity: sha512-i/2XbnSz/uxRCU6+NdVJgKWDTM427+MqYbkQzD321DuCQJUqOuJKIA0IM2+W2xtYHdKOmZ4dR6fExsd4SXL+WQ==}
     engines: {node: '>=6'}
 
+  eventemitter3@5.0.4:
+    resolution: {integrity: sha512-mlsTRyGaPBjPedk6Bvw+aqbsXDtoAyAzm5MO7JgU+yVRyMQ5O8bD4Kcci7BS85f93veegeCPkL8R4GLClnjLFw==}
+
   exec-async@2.2.0:
     resolution: {integrity: sha512-87OpwcEiMia/DeiKFzaQNBNFeN3XkkpYIh9FyOqq5mS2oKv3CBE67PXoEKcr6nodWdXNogTiQ0jE2NGuoffXPw==}
 
+  expect-type@1.3.0:
+    resolution: {integrity: sha512-knvyeauYhqjOYvQ66MznSMs83wmHrCycNEN6Ao+2AeYEfxUIkuiVxdEa1qlGEPK+We3n0THiDciYSsCcgW/DoA==}
+    engines: {node: '>=12.0.0'}
+
   expo-asset@12.0.12:
     resolution: {integrity: sha512-CsXFCQbx2fElSMn0lyTdRIyKlSXOal6ilLJd+yeZ6xaC7I9AICQgscY5nj0QcwgA+KYYCCEQEBndMsmj7drOWQ==}
     peerDependencies:
@@ -2267,6 +2871,10 @@ packages:
   exponential-backoff@3.1.3:
     resolution: {integrity: sha512-ZgEeZXj30q+I0EN+CbSSpIyPaJ5HVQD18Z1m+u1FXbAeT94mr1zw50q4q6jiiC447Nl/YTcIYSAftiGqetwXCA==}
 
+  eyes@0.1.8:
+    resolution: {integrity: sha512-GipyPsXO1anza0AOZdy69Im7hGFCNB7Y/NGjDlZGJ3GJJLtwNSb2vrzYrTYJRrRloVx7pl+bhUaTB8yiccPvFQ==}
+    engines: {node: '> 0.1.90'}
+
   fast-deep-equal@3.1.3:
     resolution: {integrity: sha512-f3qQ9oQy9j2AhBe/H9VC91wLmKBCCU/gDOnKNAYG5hswO7BLKj09Hc5HYNz9cGI++xlpDCIgDaitVs03ATR84Q==}
 
@@ -2280,6 +2888,12 @@ packages:
   fast-levenshtein@2.0.6:
     resolution: {integrity: sha512-DCXu6Ifhqcks7TZKY3Hxp3y6qphY5SJZmrWMDrKcERSOXWQdMhU9Ig/PYrzyw/ul9jOIyh0N4M0tbC5hodg8dw==}
 
+  fast-stable-stringify@1.0.0:
+    resolution: {integrity: sha512-wpYMUmFu5f00Sm0cj2pfivpmawLZ0NKdviQ4w9zJeR8JVtOpOxHmLaJuj0vxvGqMJQWyP/COUkF75/57OKyRag==}
+
+  fastestsmallesttextencoderdecoder@1.0.22:
+    resolution: {integrity: sha512-Pb8d48e+oIuY4MaM64Cd7OW1gt4nxCHs7/ddPPZ/Ic3sg8yVGM7O9wDvZ7us6ScaUupzM+pfBolwtYhN1IxBIw==}
+
   fastq@1.20.1:
     resolution: {integrity: sha512-GGToxJ/w1x32s/D2EKND7kTil4n8OVk/9mycTc4VDza13lOvpUZTGX3mFSCtV9ksdGBVzvsyAVLM6mHFThxXxw==}
 
@@ -2505,6 +3119,9 @@ packages:
     resolution: {integrity: sha512-vK9P5/iUfdl95AI+JVyUuIcVtd4ofvtrOr3HNtM2yxC9bnMbEdp3x01OhQNnjb8IJYi38VlTE3mBXwcfvywuSw==}
     engines: {node: '>= 14'}
 
+  humanize-ms@1.2.1:
+    resolution: {integrity: sha512-Fl70vYtsAFb/C06PTS9dZBo7ihau+Tu/DNCk/OyHhea07S+aeMWpFFkUaXRa8fI+ScZbEI8dfSxwY7gxZ9SAVQ==}
+
   hyphenate-style-name@1.1.0:
     resolution: {integrity: sha512-WDC/ui2VVRrz3jOVi+XtjqkDjiVjTtFaAGiW37k6b+ohyQ5wYDOGkvCZa8+H0nx3gyvv0+BST9xuOgIyGQ00gw==}
 
@@ -2674,6 +3291,11 @@ packages:
   isexe@2.0.0:
     resolution: {integrity: sha512-RHxMLp9lnKHGHRng9QFhRCMbYAcVpn69smSGcq3f36xjgVVWThj4qqLbTLlq7Ssj8B+fIQ1EuCEGI2lKsyQeIw==}
 
+  isomorphic-ws@4.0.1:
+    resolution: {integrity: sha512-BhBvN2MBpWTaSHdWRb/bwdZJ1WaehQ2L1KngkCkfLUGF0mAWAT1sQUQacEmQ0jXkFw/czDXPNQSL5u2/Krsz1w==}
+    peerDependencies:
+      ws: '*'
+
   istanbul-lib-coverage@3.2.2:
     resolution: {integrity: sha512-O8dpsF+r0WV/8MNRKfnmrtCWhuKjxrq2w+jpzBL5UZKTi2LeVWnWOmWRxFlesJONmc+wLAGvKQZEOanko0LFTg==}
     engines: {node: '>=8'}
@@ -2686,6 +3308,11 @@ packages:
     resolution: {integrity: sha512-H0dkQoCa3b2VEeKQBOxFph+JAbcrQdE7KC0UkqwpLmv2EC4P41QXP+rqo9wYodACiG5/WM5s9oDApTU8utwj9g==}
     engines: {node: '>= 0.4'}
 
+  jayson@4.3.0:
+    resolution: {integrity: sha512-AauzHcUcqs8OBnCHOkJY280VaTiCm57AbuO7lqzcw7JapGj50BisE3xhksye4zlTSR1+1tAz67wLTl8tEH1obQ==}
+    engines: {node: '>=8'}
+    hasBin: true
+
   jest-environment-node@29.7.0:
     resolution: {integrity: sha512-DOSwCRqXirTOyheM+4d5YZOrWcdu0LNZ87ewUoywbcb2XR4wKgqiG8vNeYwhjFMbEkfju7wx2GYH0P2gevGvFw==}
     engines: {node: ^14.15.0 || ^16.10.0 || >=18.0.0}
@@ -2729,9 +3356,15 @@ packages:
     resolution: {integrity: sha512-ekilCSN1jwRvIbgeg/57YFh8qQDNbwDb9xT/qu2DAHbFFZUicIl4ygVaAvzveMhMVr3LnpSKTNnwt8PoOfmKhQ==}
     hasBin: true
 
+  js-base64@3.7.8:
+    resolution: {integrity: sha512-hNngCeKxIUQiEUN3GPJOkz4wF/YvdUdbNL9hsBcMQTkKzboD7T/q3OYOuuPZLUE6dBxSGpwhk5mwuDud7JVAow==}
+
   js-tokens@4.0.0:
     resolution: {integrity: sha512-RdJUflcE3cUzKiMqQgsCu06FPu9UdIJO0beYbPhHN4k6apgJtifcoCtT9bcxOpYBtpD2kCM6Sbzg4CausW/PKQ==}
 
+  js-tokens@9.0.1:
+    resolution: {integrity: sha512-mxa9E9ITFOt0ban3j6L5MpjwegGz6lBQmM1IJkWeBZGcMxto50+eWdjC/52xDbS2vy0k7vIMK0Fe2wfL9OQSpQ==}
+
   js-yaml@3.14.2:
     resolution: {integrity: sha512-PMSmkqxr106Xa156c2M265Z+FTrPl+oxd/rgOQy2tijQeK5TxQ43psO1ZCwhVOSdnn+RzkzlRz/eY4BgJBYVpg==}
     hasBin: true
@@ -2757,6 +3390,9 @@ packages:
   json-stable-stringify-without-jsonify@1.0.1:
     resolution: {integrity: sha512-Bdboy+l7tA3OGW6FjyFHWkP5LuByj1Tk33Ljyq0axyzdk9//JSi2u3fP1QSmd1KNwq6VOKYGlAu87CisVir6Pw==}
 
+  json-stringify-safe@5.0.1:
+    resolution: {integrity: sha512-ZClg6AaYvamvYEE82d3Iyd3vSSIjQ+odgjaTzRuO3s7toCdFKczob2i0zCh7JE8kWn17yvAWhUVxvqGwUalsRA==}
+
   json5@1.0.2:
     resolution: {integrity: sha512-g1MWMLBiz8FKi1e4w0UyVL3w+iJceWAFBAaBnnGKOpNa5f8TLktkbre1+s6oICydWAm+HRUGTmI+//xv2hvXYA==}
     hasBin: true
@@ -2901,6 +3537,9 @@ packages:
     resolution: {integrity: sha512-lyuxPGr/Wfhrlem2CL/UcnUc1zcqKAImBDzukY7Y5F/yQiNdko6+fRLevlw1HgMySw7f611UIY408EtxRSoK3Q==}
     hasBin: true
 
+  loupe@3.2.1:
+    resolution: {integrity: sha512-CdzqowRJCeLU72bHvWqwRBBlLcMEtIvGrlvef74kMnV2AolS9Y8xUv1I0U/MNAWMhBlKIoyuEgoJ0t/bbwHbLQ==}
+
   lru-cache@10.4.3:
     resolution: {integrity: sha512-JNAzZcXrCt42VGLuYz0zfAzDfAvJWW6AfYlDBQyDV5DClI2m5sAmK+OIO7s59XfsRsWHp02jAJrRadPRGTt6SQ==}
 
@@ -3184,6 +3823,10 @@ packages:
     resolution: {integrity: sha512-rLvcdSyRCyouf6jcOIPe/BgwG/d7hKjzMKOas33/pHEr6gbq18IK9zV7DiPvzsz0oBJPme6qr6H6kGZuI9/DZg==}
     engines: {node: '>= 6.13.0'}
 
+  node-gyp-build@4.8.4:
+    resolution: {integrity: sha512-LA4ZjwlnUblHVgq0oBF3Jl/6h/Nvs5fzBLwdEF4nuxnFdsfajde4WfxtJr3CaiH+F6ewcIB/q4jQ4UzPyid+CQ==}
+    hasBin: true
+
   node-int64@0.4.0:
     resolution: {integrity: sha512-O5lz91xSOeoXP6DulyHfllpq+Eg00MWitZIbtPfoSEvqIHdl5gfcY6hYzDWnj0qD5tz52PI08u9qUvSVeUBeHw==}
 
@@ -3331,6 +3974,13 @@ packages:
     resolution: {integrity: sha512-3O/iVVsJAPsOnpwWIeD+d6z/7PmqApyQePUtCndjatj/9I5LylHvt5qluFaBT3I5h3r1ejfR056c+FCv+NnNXg==}
     engines: {node: 18 || 20 || >=22}
 
+  pathe@2.0.3:
+    resolution: {integrity: sha512-WUjGcAqP1gQacoQe+OBJsFA7Ld4DyXuUIjZ5cc75cLHvJ7dtNsTugphxIADwspS+AraAUePCKrSVtPLFj/F88w==}
+
+  pathval@2.0.1:
+    resolution: {integrity: sha512-//nshmD55c46FuFw26xV/xFAaB5HF9Xdap7HJBBnrKdAd6/GxDBaNA1870O79+9ueg61cZLSVc+OaFlfmObYVQ==}
+    engines: {node: '>= 14.16'}
+
   picocolors@1.1.1:
     resolution: {integrity: sha512-xceH2snhtb5M9liqDsmEw56le376mTZkEX/jEb/RxNFyegNul7eNslCXP9FDj/Lcu0X8KEyMceP2ntpaHrDEVA==}
 
@@ -3575,6 +4225,14 @@ packages:
     deprecated: Rimraf versions prior to v4 are no longer supported
     hasBin: true
 
+  rollup@4.58.0:
+    resolution: {integrity: sha512-wbT0mBmWbIvvq8NeEYWWvevvxnOyhKChir47S66WCxw1SXqhw7ssIYejnQEVt7XYQpsj2y8F9PM+Cr3SNEa0gw==}
+    engines: {node: '>=18.0.0', npm: '>=8.0.0'}
+    hasBin: true
+
+  rpc-websockets@9.3.3:
+    resolution: {integrity: sha512-OkCsBBzrwxX4DoSv4Zlf9DgXKRB0MzVfCFg5MC+fNnf9ktr4SMWjsri0VNZQlDbCnGcImT6KNEv4ZoxktQhdpA==}
+
   run-parallel@1.2.0:
     resolution: {integrity: sha512-5l4VyZR86LZ/lDxZTR6jqL8AFE2S0IFLMP26AbjsLVADxHdhB/c0GUsH+y39UfCi3dzz8OlQuPmnaJOMoDHQBA==}
 
@@ -3674,6 +4332,9 @@ packages:
     resolution: {integrity: sha512-ZX99e6tRweoUXqR+VBrslhda51Nh5MTQwou5tnUDgbtyM0dBgmhEDtWGP/xbKn6hqfPRHujUNwz5fy/wbbhnpw==}
     engines: {node: '>= 0.4'}
 
+  siginfo@2.0.0:
+    resolution: {integrity: sha512-ybx0WO1/8bSBLEWXZvEd7gMW3Sn3JFlW3TvX1nREbDLRNQNaeNN8WK0meBwPdAaOI7TtRRRJn/Es1zhrrCHu7g==}
+
   signal-exit@3.0.7:
     resolution: {integrity: sha512-wnD2ZE+l+SPC/uoS0vXeE9L1+0wuaMqKlfz9AMUo38JsyLSBWSFcHR1Rri62LZc12vLr1gb3jl7iwQhgwpAbGQ==}
 
@@ -3716,6 +4377,9 @@ packages:
     resolution: {integrity: sha512-XlkWvfIm6RmsWtNJx+uqtKLS8eqFbxUg0ZzLXqY0caEy9l7hruX8IpiDnjsLavoBgqCCR71TqWO8MaXYheJ3RQ==}
     engines: {node: '>=10'}
 
+  stackback@0.0.2:
+    resolution: {integrity: sha512-1XMJE5fQo1jGH6Y/7ebnwPOBEkIEnT4QF32d5R1+VXdXveM0IBMJt8zfaxX1P3QhVwrYe+576+jkANtSS2mBbw==}
+
   stackframe@1.3.4:
     resolution: {integrity: sha512-oeVtt7eWQS+Na6F//S4kJ2K2VbRlS9D43mAlMyVpVWovy9o+jfgH8O9agzANzaiLjclA0oYzUXEM4PurhSUChw==}
 
@@ -3731,6 +4395,9 @@ packages:
     resolution: {integrity: sha512-DvEy55V3DB7uknRo+4iOGT5fP1slR8wQohVdknigZPMpMstaKJQWhwiYBACJE3Ul2pTnATihhBYnRhZQHGBiRw==}
     engines: {node: '>= 0.8'}
 
+  std-env@3.10.0:
+    resolution: {integrity: sha512-5GS12FdOZNliM5mAOxFRg7Ir0pWz8MdpYm6AY6VPkGpbA7ZzmbzNcBJQ0GPvvyWgcY7QAhCgf9Uy89I03faLkg==}
+
   stop-iteration-iterator@1.1.0:
     resolution: {integrity: sha512-eLoXW/DHyl62zxY4SCaIgnRhuMr6ri4juEYARS8E6sCEqzKpOiE521Ucofdx+KnDZl5xmvGYaaKCk5FEOxJCoQ==}
     engines: {node: '>= 0.4'}
@@ -3739,6 +4406,12 @@ packages:
     resolution: {integrity: sha512-uyQK/mx5QjHun80FLJTfaWE7JtwfRMKBLkMne6udYOmvH0CawotVa7TfgYHzAnpphn4+TweIx1QKMnRIbipmUg==}
     engines: {node: '>= 0.10.0'}
 
+  stream-chain@2.2.5:
+    resolution: {integrity: sha512-1TJmBx6aSWqZ4tx7aTpBDXK0/e2hhcNSTV8+CbFJtDjbb+I1mZ8lHit0Grw9GRT+6JbIrrDd8esncgBi8aBXGA==}
+
+  stream-json@1.9.1:
+    resolution: {integrity: sha512-uWkjJ+2Nt/LO9Z/JyKZbMusL8Dkh97uUBTv3AJQ74y07lVahLY4eEFsPsE97pxYBwr8nnjMAIch5eqI0gPShyw==}
+
   string-width@4.2.3:
     resolution: {integrity: sha512-wKyQRQpjJ0sIp62ErSZdGsjMJWsap5oRNihHhu6G7JVO/9jIB6UyevL+tXuOqrng8j/cxKTWyWUwvSTriiZz/g==}
     engines: {node: '>=8'}
@@ -3786,6 +4459,9 @@ packages:
     resolution: {integrity: sha512-6fPc+R4ihwqP6N/aIv2f1gMH8lOVtWQHoqC4yK6oSDVVocumAsfCqjkXnqiYMhmMwS/mEHLp7Vehlt3ql6lEig==}
     engines: {node: '>=8'}
 
+  strip-literal@3.1.0:
+    resolution: {integrity: sha512-8r3mkIM/2+PpjHoOtiAW8Rg3jJLHaV7xPwG+YRGrv6FP0wwk/toTpATxWYOW0BKdWwl82VT2tFYi5DlROa0Mxg==}
+
   structured-headers@0.4.1:
     resolution: {integrity: sha512-0MP/Cxx5SzeeZ10p/bZI0S6MpgD+yxAhi1BOQ34jgnMXsCq3j1t6tQnZu+KdlL7dvJTLT3g9xN8tl10TqgFMcg==}
 
@@ -3810,6 +4486,10 @@ packages:
     engines: {node: '>=16 || 14 >=14.17'}
     hasBin: true
 
+  superstruct@2.0.2:
+    resolution: {integrity: sha512-uV+TFRZdXsqXTL2pRvujROjdZQ4RAlBUS5BTh9IGm+jTqQntYThciG/qu57Gs69yjnVUSqdxF9YLmSnpupBW9A==}
+    engines: {node: '>=14.0.0'}
+
   supports-color@5.5.0:
     resolution: {integrity: sha512-QjVjwdXIt408MIiAqCX4oUKsgU2EqAGzs2Ppkm4aQYbjm+ZEWEcW4SfFNTr4uMNZma0ey4f5lgLrkB0aX0QMow==}
     engines: {node: '>=4'}
@@ -3858,6 +4538,9 @@ packages:
     resolution: {integrity: sha512-cAGWPIyOHU6zlmg88jwm7VRyXnMN7iV68OGAbYDk/Mh/xC/pzVPlQtY6ngoIH/5/tciuhGfvESU8GrHrcxD56w==}
     engines: {node: '>=8'}
 
+  text-encoding-utf-8@1.0.2:
+    resolution: {integrity: sha512-8bw4MY9WjdsD2aMtO0OzOCY3pXGYNx2d2FfHRVUKkiCPDWjKuOlhLVASS+pD7VkLTVjW268LYJHwsnPFlBpbAg==}
+
   thenify-all@1.6.0:
     resolution: {integrity: sha512-RNxQH/qI8/t3thXJDwcstUO4zeqo64+Uy/+sNVRBx4Xn2OX+OZ9oP+iJnNFqplFra2ZUVeKCSa2oVWi3T4uVmA==}
     engines: {node: '>=0.8'}
@@ -3868,10 +4551,28 @@ packages:
   throat@5.0.0:
     resolution: {integrity: sha512-fcwX4mndzpLQKBS1DVYhGAcYaYt7vsHNIvQV+WXMvnow5cgjPphq5CaayLaGsjRdSCKZFNGt7/GYAuXaNOiYCA==}
 
+  tinybench@2.9.0:
+    resolution: {integrity: sha512-0+DUvqWMValLmha6lr4kD8iAMK1HzV0/aKnCtWb9v9641TnP/MFb7Pc2bxoxQjTXAErryXVgUOfv2YqNllqGeg==}
+
+  tinyexec@0.3.2:
+    resolution: {integrity: sha512-KQQR9yN7R5+OSwaK0XQoj22pwHoTlgYqmUscPYoknOoWCWfj/5/ABTMRi69FrKU5ffPVh5QcFikpWJI/P1ocHA==}
+
   tinyglobby@0.2.15:
     resolution: {integrity: sha512-j2Zq4NyQYG5XMST4cbs02Ak8iJUdxRM0XI5QyxXuZOzKOINmWurp3smXu3y5wDcJrptwpSjgXHzIQxR0omXljQ==}
     engines: {node: '>=12.0.0'}
 
+  tinypool@1.1.1:
+    resolution: {integrity: sha512-Zba82s87IFq9A9XmjiX5uZA/ARWDrB03OHlq+Vw1fSdt0I+4/Kutwy8BP4Y/y/aORMo61FQ0vIb5j44vSo5Pkg==}
+    engines: {node: ^18.0.0 || >=20.0.0}
+
+  tinyrainbow@2.0.0:
+    resolution: {integrity: sha512-op4nsTR47R6p0vMUUoYl/a+ljLFVtlfaXkLQmqfLR1qHma1h/ysYk4hEXZ880bf2CYgTskvTa/e196Vd5dDQXw==}
+    engines: {node: '>=14.0.0'}
+
+  tinyspy@4.0.4:
+    resolution: {integrity: sha512-azl+t0z7pw/z958Gy9svOTuzqIk6xq+NSheJzn5MMWtWTFywIacg2wUlzKFGtt3cthx0r2SxMK0yzJOR0IES7Q==}
+    engines: {node: '>=14.0.0'}
+
   tmpl@1.0.5:
     resolution: {integrity: sha512-3f0uOEAQwIqGuWW2MVzYg8fV/QNnc/IpuJNG837rLuczAaLVHslWHZQj4IGiEl5Hs3kkbhwL9Ab7Hrsmuj+Smw==}
 
@@ -3996,6 +4697,10 @@ packages:
   uri-js@4.4.1:
     resolution: {integrity: sha512-7rKUyy33Q1yc98pQ1DAmLtwX109F7TIfWlW1Ydo8Wl1ii1SeHieeh0HHfPeL2fMXK6z0s8ecKs9frCuLJvndBg==}
 
+  utf-8-validate@5.0.10:
+    resolution: {integrity: sha512-Z6czzLq4u8fPOyx7TU6X3dvUZVvoJmxSQ+IcrlmagKhilxlhZgxPK6C5Jqbkw1IDUmFTM+cz9QDnnLTwDz/2gQ==}
+    engines: {node: '>=6.14.2'}
+
   utils-merge@1.0.1:
     resolution: {integrity: sha512-pMZTvIkT1d+TFGvDOqodOclx0QWkkgi6Tdoa8gC8ffGAAqz9pzPTZWAybbsHHoED/ztMtkv/VoYTYyShUn81hA==}
     engines: {node: '>= 0.4.0'}
@@ -4004,6 +4709,10 @@ packages:
     resolution: {integrity: sha512-DPSke0pXhTZgoF/d+WSt2QaKMCFSfx7QegxEWT+JOuHF5aWrKEn0G+ztjuJg/gG8/ItK+rbPCD/yNv8yyih6Cg==}
     hasBin: true
 
+  uuid@8.3.2:
+    resolution: {integrity: sha512-+NYs2QeMWy+GWFOEm9xnn6HCDp0l7QBD7ml8zLUmJ+93Q5NF0NocErnwkTkXVFNiX3/fpC6afS8Dhb/gz7R7eg==}
+    hasBin: true
+
   validate-npm-package-name@5.0.1:
     resolution: {integrity: sha512-OljLrQ9SQdOUqTaQxqL5dEfZWrXExyyWsozYlAWFawPVNuD83igl7uJD2RTkNMbniIYgt8l81eCJGIdQF7avLQ==}
     engines: {node: ^14.17.0 || ^16.13.0 || >=18.0.0}
@@ -4012,6 +4721,79 @@ packages:
     resolution: {integrity: sha512-BNGbWLfd0eUPabhkXUVm0j8uuvREyTh5ovRa/dyow/BqAbZJyC+5fU+IzQOzmAKzYqYRAISoRhdQr3eIZ/PXqg==}
     engines: {node: '>= 0.8'}
 
+  vite-node@3.2.4:
+    resolution: {integrity: sha512-EbKSKh+bh1E1IFxeO0pg1n4dvoOTt0UDiXMd/qn++r98+jPO1xtJilvXldeuQ8giIB5IkpjCgMleHMNEsGH6pg==}
+    engines: {node: ^18.0.0 || ^20.0.0 || >=22.0.0}
+    hasBin: true
+
+  vite@7.3.1:
+    resolution: {integrity: sha512-w+N7Hifpc3gRjZ63vYBXA56dvvRlNWRczTdmCBBa+CotUzAPf5b7YMdMR/8CQoeYE5LX3W4wj6RYTgonm1b9DA==}
+    engines: {node: ^20.19.0 || >=22.12.0}
+    hasBin: true
+    peerDependencies:
+      '@types/node': ^20.19.0 || >=22.12.0
+      jiti: '>=1.21.0'
+      less: ^4.0.0
+      lightningcss: ^1.21.0
+      sass: ^1.70.0
+      sass-embedded: ^1.70.0
+      stylus: '>=0.54.8'
+      sugarss: ^5.0.0
+      terser: ^5.16.0
+      tsx: ^4.8.1
+      yaml: ^2.4.2
+    peerDependenciesMeta:
+      '@types/node':
+        optional: true
+      jiti:
+        optional: true
+      less:
+        optional: true
+      lightningcss:
+        optional: true
+      sass:
+        optional: true
+      sass-embedded:
+        optional: true
+      stylus:
+        optional: true
+      sugarss:
+        optional: true
+      terser:
+        optional: true
+      tsx:
+        optional: true
+      yaml:
+        optional: true
+
+  vitest@3.2.4:
+    resolution: {integrity: sha512-LUCP5ev3GURDysTWiP47wRRUpLKMOfPh+yKTx3kVIEiu5KOMeqzpnYNsKyOoVrULivR8tLcks4+lga33Whn90A==}
+    engines: {node: ^18.0.0 || ^20.0.0 || >=22.0.0}
+    hasBin: true
+    peerDependencies:
+      '@edge-runtime/vm': '*'
+      '@types/debug': ^4.1.12
+      '@types/node': ^18.0.0 || ^20.0.0 || >=22.0.0
+      '@vitest/browser': 3.2.4
+      '@vitest/ui': 3.2.4
+      happy-dom: '*'
+      jsdom: '*'
+    peerDependenciesMeta:
+      '@edge-runtime/vm':
+        optional: true
+      '@types/debug':
+        optional: true
+      '@types/node':
+        optional: true
+      '@vitest/browser':
+        optional: true
+      '@vitest/ui':
+        optional: true
+      happy-dom:
+        optional: true
+      jsdom:
+        optional: true
+
   vlq@1.0.1:
     resolution: {integrity: sha512-gQpnTgkubC6hQgdIcRdYGDSDc+SaujOdyesZQMv6JlfQee/9Mp0Qhnys6WxDWvQnL5WZdT7o2Ul187aSt0Rq+w==}
 
@@ -4059,6 +4841,11 @@ packages:
     engines: {node: '>= 8'}
     hasBin: true
 
+  why-is-node-running@2.3.0:
+    resolution: {integrity: sha512-hUrmaWBdVDcxvYqnyh09zunKzROWjbZTiNy8dBEjkS7ehEDQibXJ7XvlmtbwuTclUiIyN+CyXQD4Vmko8fNm8w==}
+    engines: {node: '>=8'}
+    hasBin: true
+
   wonka@6.3.5:
     resolution: {integrity: sha512-SSil+ecw6B4/Dm7Pf2sAshKQ5hWFvfyGlfPbEd6A14dOH6VDjrmbY86u6nZvy9omGwwIPFR8V41+of1EezgoUw==}
 
@@ -4792,6 +5579,84 @@ snapshots:
       tslib: 2.8.1
     optional: true
 
+  '@esbuild/aix-ppc64@0.27.3':
+    optional: true
+
+  '@esbuild/android-arm64@0.27.3':
+    optional: true
+
+  '@esbuild/android-arm@0.27.3':
+    optional: true
+
+  '@esbuild/android-x64@0.27.3':
+    optional: true
+
+  '@esbuild/darwin-arm64@0.27.3':
+    optional: true
+
+  '@esbuild/darwin-x64@0.27.3':
+    optional: true
+
+  '@esbuild/freebsd-arm64@0.27.3':
+    optional: true
+
+  '@esbuild/freebsd-x64@0.27.3':
+    optional: true
+
+  '@esbuild/linux-arm64@0.27.3':
+    optional: true
+
+  '@esbuild/linux-arm@0.27.3':
+    optional: true
+
+  '@esbuild/linux-ia32@0.27.3':
+    optional: true
+
+  '@esbuild/linux-loong64@0.27.3':
+    optional: true
+
+  '@esbuild/linux-mips64el@0.27.3':
+    optional: true
+
+  '@esbuild/linux-ppc64@0.27.3':
+    optional: true
+
+  '@esbuild/linux-riscv64@0.27.3':
+    optional: true
+
+  '@esbuild/linux-s390x@0.27.3':
+    optional: true
+
+  '@esbuild/linux-x64@0.27.3':
+    optional: true
+
+  '@esbuild/netbsd-arm64@0.27.3':
+    optional: true
+
+  '@esbuild/netbsd-x64@0.27.3':
+    optional: true
+
+  '@esbuild/openbsd-arm64@0.27.3':
+    optional: true
+
+  '@esbuild/openbsd-x64@0.27.3':
+    optional: true
+
+  '@esbuild/openharmony-arm64@0.27.3':
+    optional: true
+
+  '@esbuild/sunos-x64@0.27.3':
+    optional: true
+
+  '@esbuild/win32-arm64@0.27.3':
+    optional: true
+
+  '@esbuild/win32-ia32@0.27.3':
+    optional: true
+
+  '@esbuild/win32-x64@0.27.3':
+    optional: true
+
   '@eslint-community/eslint-utils@4.9.1(eslint@9.39.3(jiti@2.6.1))':
     dependencies:
       eslint: 9.39.3(jiti@2.6.1)
@@ -4838,7 +5703,7 @@ snapshots:
       '@eslint/core': 0.17.0
       levn: 0.4.1
 
-  '@expo/cli@54.0.23(expo@54.0.33(@babel/core@7.29.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0))(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))':
+  '@expo/cli@54.0.23(bufferutil@4.1.0)(expo@54.0.33(@babel/core@7.29.0)(bufferutil@4.1.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)(utf-8-validate@5.0.10))(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(utf-8-validate@5.0.10)':
     dependencies:
       '@0no-co/graphql.web': 1.2.0
       '@expo/code-signing-certificates': 0.0.6
@@ -4848,17 +5713,17 @@ snapshots:
       '@expo/env': 2.0.8
       '@expo/image-utils': 0.8.8
       '@expo/json-file': 10.0.8
-      '@expo/metro': 54.2.0
-      '@expo/metro-config': 54.0.14(expo@54.0.33(@babel/core@7.29.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0))
+      '@expo/metro': 54.2.0(bufferutil@4.1.0)(utf-8-validate@5.0.10)
+      '@expo/metro-config': 54.0.14(bufferutil@4.1.0)(expo@54.0.33(@babel/core@7.29.0)(bufferutil@4.1.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)(utf-8-validate@5.0.10))(utf-8-validate@5.0.10)
       '@expo/osascript': 2.3.8
       '@expo/package-manager': 1.9.10
       '@expo/plist': 0.4.8
-      '@expo/prebuild-config': 54.0.8(expo@54.0.33(@babel/core@7.29.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0))
+      '@expo/prebuild-config': 54.0.8(expo@54.0.33(@babel/core@7.29.0)(bufferutil@4.1.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)(utf-8-validate@5.0.10))
       '@expo/schema-utils': 0.1.8
       '@expo/spawn-async': 1.7.2
       '@expo/ws-tunnel': 1.0.6
       '@expo/xcpretty': 4.4.0
-      '@react-native/dev-middleware': 0.81.5
+      '@react-native/dev-middleware': 0.81.5(bufferutil@4.1.0)(utf-8-validate@5.0.10)
       '@urql/core': 5.2.0
       '@urql/exchange-retry': 1.3.2(@urql/core@5.2.0)
       accepts: 1.3.8
@@ -4872,7 +5737,7 @@ snapshots:
       connect: 3.7.0
       debug: 4.4.3
       env-editor: 0.4.2
-      expo: 54.0.33(@babel/core@7.29.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0)
+      expo: 54.0.33(@babel/core@7.29.0)(bufferutil@4.1.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)(utf-8-validate@5.0.10)
       expo-server: 1.0.5
       freeport-async: 2.0.0
       getenv: 2.0.0
@@ -4903,9 +5768,9 @@ snapshots:
       terminal-link: 2.1.1
       undici: 6.23.0
       wrap-ansi: 7.0.0
-      ws: 8.19.0
+      ws: 8.19.0(bufferutil@4.1.0)(utf-8-validate@5.0.10)
     optionalDependencies:
-      react-native: 0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0)
+      react-native: 0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10)
     transitivePeerDependencies:
       - bufferutil
       - graphql
@@ -4962,12 +5827,12 @@ snapshots:
     transitivePeerDependencies:
       - supports-color
 
-  '@expo/devtools@0.1.8(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0)':
+  '@expo/devtools@0.1.8(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)':
     dependencies:
       chalk: 4.1.2
     optionalDependencies:
       react: 19.1.0
-      react-native: 0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0)
+      react-native: 0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10)
 
   '@expo/env@2.0.8':
     dependencies:
@@ -5013,7 +5878,7 @@ snapshots:
       '@babel/code-frame': 7.10.4
       json5: 2.2.3
 
-  '@expo/metro-config@54.0.14(expo@54.0.33(@babel/core@7.29.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0))':
+  '@expo/metro-config@54.0.14(bufferutil@4.1.0)(expo@54.0.33(@babel/core@7.29.0)(bufferutil@4.1.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)(utf-8-validate@5.0.10))(utf-8-validate@5.0.10)':
     dependencies:
       '@babel/code-frame': 7.29.0
       '@babel/core': 7.29.0
@@ -5021,7 +5886,7 @@ snapshots:
       '@expo/config': 12.0.13
       '@expo/env': 2.0.8
       '@expo/json-file': 10.0.8
-      '@expo/metro': 54.2.0
+      '@expo/metro': 54.2.0(bufferutil@4.1.0)(utf-8-validate@5.0.10)
       '@expo/spawn-async': 1.7.2
       browserslist: 4.28.1
       chalk: 4.1.2
@@ -5037,19 +5902,19 @@ snapshots:
       postcss: 8.4.49
       resolve-from: 5.0.0
     optionalDependencies:
-      expo: 54.0.33(@babel/core@7.29.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0)
+      expo: 54.0.33(@babel/core@7.29.0)(bufferutil@4.1.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)(utf-8-validate@5.0.10)
     transitivePeerDependencies:
       - bufferutil
       - supports-color
       - utf-8-validate
 
-  '@expo/metro@54.2.0':
+  '@expo/metro@54.2.0(bufferutil@4.1.0)(utf-8-validate@5.0.10)':
     dependencies:
-      metro: 0.83.3
+      metro: 0.83.3(bufferutil@4.1.0)(utf-8-validate@5.0.10)
       metro-babel-transformer: 0.83.3
       metro-cache: 0.83.3
       metro-cache-key: 0.83.3
-      metro-config: 0.83.3
+      metro-config: 0.83.3(bufferutil@4.1.0)(utf-8-validate@5.0.10)
       metro-core: 0.83.3
       metro-file-map: 0.83.3
       metro-minify-terser: 0.83.3
@@ -5058,7 +5923,7 @@ snapshots:
       metro-source-map: 0.83.3
       metro-symbolicate: 0.83.3
       metro-transform-plugins: 0.83.3
-      metro-transform-worker: 0.83.3
+      metro-transform-worker: 0.83.3(bufferutil@4.1.0)(utf-8-validate@5.0.10)
     transitivePeerDependencies:
       - bufferutil
       - supports-color
@@ -5084,7 +5949,7 @@ snapshots:
       base64-js: 1.5.1
       xmlbuilder: 15.1.1
 
-  '@expo/prebuild-config@54.0.8(expo@54.0.33(@babel/core@7.29.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0))':
+  '@expo/prebuild-config@54.0.8(expo@54.0.33(@babel/core@7.29.0)(bufferutil@4.1.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)(utf-8-validate@5.0.10))':
     dependencies:
       '@expo/config': 12.0.13
       '@expo/config-plugins': 54.0.4
@@ -5093,7 +5958,7 @@ snapshots:
       '@expo/json-file': 10.0.8
       '@react-native/normalize-colors': 0.81.5
       debug: 4.4.3
-      expo: 54.0.33(@babel/core@7.29.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0)
+      expo: 54.0.33(@babel/core@7.29.0)(bufferutil@4.1.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)(utf-8-validate@5.0.10)
       resolve-from: 5.0.0
       semver: 7.7.4
       xml2js: 0.6.0
@@ -5110,11 +5975,11 @@ snapshots:
 
   '@expo/sudo-prompt@9.3.2': {}
 
-  '@expo/vector-icons@15.0.3(expo-font@14.0.11(expo@54.0.33(@babel/core@7.29.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0))(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0))(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0)':
+  '@expo/vector-icons@15.0.3(expo-font@14.0.11(expo@54.0.33(@babel/core@7.29.0)(bufferutil@4.1.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)(utf-8-validate@5.0.10))(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0))(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)':
     dependencies:
-      expo-font: 14.0.11(expo@54.0.33(@babel/core@7.29.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0))(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0)
+      expo-font: 14.0.11(expo@54.0.33(@babel/core@7.29.0)(bufferutil@4.1.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)(utf-8-validate@5.0.10))(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)
       react: 19.1.0
-      react-native: 0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0)
+      react-native: 0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10)
 
   '@expo/ws-tunnel@1.0.6': {}
 
@@ -5362,6 +6227,12 @@ snapshots:
   '@next/swc-win32-x64-msvc@16.1.6':
     optional: true
 
+  '@noble/curves@1.9.7':
+    dependencies:
+      '@noble/hashes': 1.8.0
+
+  '@noble/hashes@1.8.0': {}
+
   '@nodelib/fs.scandir@2.1.5':
     dependencies:
       '@nodelib/fs.stat': 2.0.5
@@ -5436,78 +6307,324 @@ snapshots:
     transitivePeerDependencies:
       - supports-color
 
-  '@react-native/codegen@0.81.5(@babel/core@7.29.0)':
+  '@react-native/codegen@0.81.5(@babel/core@7.29.0)':
+    dependencies:
+      '@babel/core': 7.29.0
+      '@babel/parser': 7.29.0
+      glob: 7.2.3
+      hermes-parser: 0.29.1
+      invariant: 2.2.4
+      nullthrows: 1.1.1
+      yargs: 17.7.2
+
+  '@react-native/community-cli-plugin@0.81.5(bufferutil@4.1.0)(utf-8-validate@5.0.10)':
+    dependencies:
+      '@react-native/dev-middleware': 0.81.5(bufferutil@4.1.0)(utf-8-validate@5.0.10)
+      debug: 4.4.3
+      invariant: 2.2.4
+      metro: 0.83.4(bufferutil@4.1.0)(utf-8-validate@5.0.10)
+      metro-config: 0.83.4(bufferutil@4.1.0)(utf-8-validate@5.0.10)
+      metro-core: 0.83.4
+      semver: 7.7.4
+    transitivePeerDependencies:
+      - bufferutil
+      - supports-color
+      - utf-8-validate
+
+  '@react-native/debugger-frontend@0.81.5': {}
+
+  '@react-native/dev-middleware@0.81.5(bufferutil@4.1.0)(utf-8-validate@5.0.10)':
+    dependencies:
+      '@isaacs/ttlcache': 1.4.1
+      '@react-native/debugger-frontend': 0.81.5
+      chrome-launcher: 0.15.2
+      chromium-edge-launcher: 0.2.0
+      connect: 3.7.0
+      debug: 4.4.3
+      invariant: 2.2.4
+      nullthrows: 1.1.1
+      open: 7.4.2
+      serve-static: 1.16.3
+      ws: 6.2.3(bufferutil@4.1.0)(utf-8-validate@5.0.10)
+    transitivePeerDependencies:
+      - bufferutil
+      - supports-color
+      - utf-8-validate
+
+  '@react-native/gradle-plugin@0.81.5': {}
+
+  '@react-native/js-polyfills@0.81.5': {}
+
+  '@react-native/normalize-colors@0.74.89': {}
+
+  '@react-native/normalize-colors@0.81.5': {}
+
+  '@react-native/virtualized-lists@0.81.5(@types/react@19.1.17)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)':
+    dependencies:
+      invariant: 2.2.4
+      nullthrows: 1.1.1
+      react: 19.1.0
+      react-native: 0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10)
+    optionalDependencies:
+      '@types/react': 19.1.17
+
+  '@rollup/rollup-android-arm-eabi@4.58.0':
+    optional: true
+
+  '@rollup/rollup-android-arm64@4.58.0':
+    optional: true
+
+  '@rollup/rollup-darwin-arm64@4.58.0':
+    optional: true
+
+  '@rollup/rollup-darwin-x64@4.58.0':
+    optional: true
+
+  '@rollup/rollup-freebsd-arm64@4.58.0':
+    optional: true
+
+  '@rollup/rollup-freebsd-x64@4.58.0':
+    optional: true
+
+  '@rollup/rollup-linux-arm-gnueabihf@4.58.0':
+    optional: true
+
+  '@rollup/rollup-linux-arm-musleabihf@4.58.0':
+    optional: true
+
+  '@rollup/rollup-linux-arm64-gnu@4.58.0':
+    optional: true
+
+  '@rollup/rollup-linux-arm64-musl@4.58.0':
+    optional: true
+
+  '@rollup/rollup-linux-loong64-gnu@4.58.0':
+    optional: true
+
+  '@rollup/rollup-linux-loong64-musl@4.58.0':
+    optional: true
+
+  '@rollup/rollup-linux-ppc64-gnu@4.58.0':
+    optional: true
+
+  '@rollup/rollup-linux-ppc64-musl@4.58.0':
+    optional: true
+
+  '@rollup/rollup-linux-riscv64-gnu@4.58.0':
+    optional: true
+
+  '@rollup/rollup-linux-riscv64-musl@4.58.0':
+    optional: true
+
+  '@rollup/rollup-linux-s390x-gnu@4.58.0':
+    optional: true
+
+  '@rollup/rollup-linux-x64-gnu@4.58.0':
+    optional: true
+
+  '@rollup/rollup-linux-x64-musl@4.58.0':
+    optional: true
+
+  '@rollup/rollup-openbsd-x64@4.58.0':
+    optional: true
+
+  '@rollup/rollup-openharmony-arm64@4.58.0':
+    optional: true
+
+  '@rollup/rollup-win32-arm64-msvc@4.58.0':
+    optional: true
+
+  '@rollup/rollup-win32-ia32-msvc@4.58.0':
+    optional: true
+
+  '@rollup/rollup-win32-x64-gnu@4.58.0':
+    optional: true
+
+  '@rollup/rollup-win32-x64-msvc@4.58.0':
+    optional: true
+
+  '@rtsao/scc@1.1.0': {}
+
+  '@sinclair/typebox@0.27.10': {}
+
+  '@sinonjs/commons@3.0.1':
+    dependencies:
+      type-detect: 4.0.8
+
+  '@sinonjs/fake-timers@10.3.0':
+    dependencies:
+      '@sinonjs/commons': 3.0.1
+
+  '@solana-mobile/mobile-wallet-adapter-protocol-web3js@2.2.5(@solana/wallet-adapter-base@0.9.27(@solana/web3.js@1.98.4(bufferutil@4.1.0)(typescript@5.9.3)(utf-8-validate@5.0.10)))(@solana/web3.js@1.98.4(bufferutil@4.1.0)(typescript@5.9.3)(utf-8-validate@5.0.10))(fastestsmallesttextencoderdecoder@1.0.22)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)(typescript@5.9.3)':
+    dependencies:
+      '@solana-mobile/mobile-wallet-adapter-protocol': 2.2.5(@solana/wallet-adapter-base@0.9.27(@solana/web3.js@1.98.4(bufferutil@4.1.0)(typescript@5.9.3)(utf-8-validate@5.0.10)))(@solana/web3.js@1.98.4(bufferutil@4.1.0)(typescript@5.9.3)(utf-8-validate@5.0.10))(bs58@5.0.0)(fastestsmallesttextencoderdecoder@1.0.22)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)(typescript@5.9.3)
+      '@solana/web3.js': 1.98.4(bufferutil@4.1.0)(typescript@5.9.3)(utf-8-validate@5.0.10)
+      bs58: 5.0.0
+      js-base64: 3.7.8
+    transitivePeerDependencies:
+      - '@solana/wallet-adapter-base'
+      - fastestsmallesttextencoderdecoder
+      - react
+      - react-native
+      - typescript
+
+  '@solana-mobile/mobile-wallet-adapter-protocol@2.2.5(@solana/wallet-adapter-base@0.9.27(@solana/web3.js@1.98.4(bufferutil@4.1.0)(typescript@5.9.3)(utf-8-validate@5.0.10)))(@solana/web3.js@1.98.4(bufferutil@4.1.0)(typescript@5.9.3)(utf-8-validate@5.0.10))(bs58@5.0.0)(fastestsmallesttextencoderdecoder@1.0.22)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)(typescript@5.9.3)':
+    dependencies:
+      '@solana/codecs-strings': 4.0.0(fastestsmallesttextencoderdecoder@1.0.22)(typescript@5.9.3)
+      '@solana/wallet-standard': 1.1.4(@solana/wallet-adapter-base@0.9.27(@solana/web3.js@1.98.4(bufferutil@4.1.0)(typescript@5.9.3)(utf-8-validate@5.0.10)))(@solana/web3.js@1.98.4(bufferutil@4.1.0)(typescript@5.9.3)(utf-8-validate@5.0.10))(bs58@5.0.0)(react@19.1.0)
+      '@solana/wallet-standard-util': 1.1.2
+      '@wallet-standard/core': 1.1.1
+      js-base64: 3.7.8
+      react-native: 0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10)
+    transitivePeerDependencies:
+      - '@solana/wallet-adapter-base'
+      - '@solana/web3.js'
+      - bs58
+      - fastestsmallesttextencoderdecoder
+      - react
+      - typescript
+
+  '@solana/buffer-layout@4.0.1':
+    dependencies:
+      buffer: 6.0.3
+
+  '@solana/codecs-core@2.3.0(typescript@5.9.3)':
+    dependencies:
+      '@solana/errors': 2.3.0(typescript@5.9.3)
+      typescript: 5.9.3
+
+  '@solana/codecs-core@4.0.0(typescript@5.9.3)':
     dependencies:
-      '@babel/core': 7.29.0
-      '@babel/parser': 7.29.0
-      glob: 7.2.3
-      hermes-parser: 0.29.1
-      invariant: 2.2.4
-      nullthrows: 1.1.1
-      yargs: 17.7.2
+      '@solana/errors': 4.0.0(typescript@5.9.3)
+      typescript: 5.9.3
 
-  '@react-native/community-cli-plugin@0.81.5':
+  '@solana/codecs-numbers@2.3.0(typescript@5.9.3)':
     dependencies:
-      '@react-native/dev-middleware': 0.81.5
-      debug: 4.4.3
-      invariant: 2.2.4
-      metro: 0.83.4
-      metro-config: 0.83.4
-      metro-core: 0.83.4
-      semver: 7.7.4
-    transitivePeerDependencies:
-      - bufferutil
-      - supports-color
-      - utf-8-validate
+      '@solana/codecs-core': 2.3.0(typescript@5.9.3)
+      '@solana/errors': 2.3.0(typescript@5.9.3)
+      typescript: 5.9.3
 
-  '@react-native/debugger-frontend@0.81.5': {}
+  '@solana/codecs-numbers@4.0.0(typescript@5.9.3)':
+    dependencies:
+      '@solana/codecs-core': 4.0.0(typescript@5.9.3)
+      '@solana/errors': 4.0.0(typescript@5.9.3)
+      typescript: 5.9.3
 
-  '@react-native/dev-middleware@0.81.5':
+  '@solana/codecs-strings@4.0.0(fastestsmallesttextencoderdecoder@1.0.22)(typescript@5.9.3)':
     dependencies:
-      '@isaacs/ttlcache': 1.4.1
-      '@react-native/debugger-frontend': 0.81.5
-      chrome-launcher: 0.15.2
-      chromium-edge-launcher: 0.2.0
-      connect: 3.7.0
-      debug: 4.4.3
-      invariant: 2.2.4
-      nullthrows: 1.1.1
-      open: 7.4.2
-      serve-static: 1.16.3
-      ws: 6.2.3
-    transitivePeerDependencies:
-      - bufferutil
-      - supports-color
-      - utf-8-validate
+      '@solana/codecs-core': 4.0.0(typescript@5.9.3)
+      '@solana/codecs-numbers': 4.0.0(typescript@5.9.3)
+      '@solana/errors': 4.0.0(typescript@5.9.3)
+      fastestsmallesttextencoderdecoder: 1.0.22
+      typescript: 5.9.3
 
-  '@react-native/gradle-plugin@0.81.5': {}
+  '@solana/errors@2.3.0(typescript@5.9.3)':
+    dependencies:
+      chalk: 5.6.2
+      commander: 14.0.3
+      typescript: 5.9.3
 
-  '@react-native/js-polyfills@0.81.5': {}
+  '@solana/errors@4.0.0(typescript@5.9.3)':
+    dependencies:
+      chalk: 5.6.2
+      commander: 14.0.1
+      typescript: 5.9.3
 
-  '@react-native/normalize-colors@0.74.89': {}
+  '@solana/wallet-adapter-base@0.9.27(@solana/web3.js@1.98.4(bufferutil@4.1.0)(typescript@5.9.3)(utf-8-validate@5.0.10))':
+    dependencies:
+      '@solana/wallet-standard-features': 1.3.0
+      '@solana/web3.js': 1.98.4(bufferutil@4.1.0)(typescript@5.9.3)(utf-8-validate@5.0.10)
+      '@wallet-standard/base': 1.1.0
+      '@wallet-standard/features': 1.1.0
+      eventemitter3: 5.0.4
 
-  '@react-native/normalize-colors@0.81.5': {}
+  '@solana/wallet-standard-chains@1.1.1':
+    dependencies:
+      '@wallet-standard/base': 1.1.0
 
-  '@react-native/virtualized-lists@0.81.5(@types/react@19.1.17)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0)':
+  '@solana/wallet-standard-core@1.1.2':
     dependencies:
-      invariant: 2.2.4
-      nullthrows: 1.1.1
-      react: 19.1.0
-      react-native: 0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0)
-    optionalDependencies:
-      '@types/react': 19.1.17
+      '@solana/wallet-standard-chains': 1.1.1
+      '@solana/wallet-standard-features': 1.3.0
+      '@solana/wallet-standard-util': 1.1.2
 
-  '@rtsao/scc@1.1.0': {}
+  '@solana/wallet-standard-features@1.3.0':
+    dependencies:
+      '@wallet-standard/base': 1.1.0
+      '@wallet-standard/features': 1.1.0
 
-  '@sinclair/typebox@0.27.10': {}
+  '@solana/wallet-standard-util@1.1.2':
+    dependencies:
+      '@noble/curves': 1.9.7
+      '@solana/wallet-standard-chains': 1.1.1
+      '@solana/wallet-standard-features': 1.3.0
 
-  '@sinonjs/commons@3.0.1':
+  '@solana/wallet-standard-wallet-adapter-base@1.1.4(@solana/web3.js@1.98.4(bufferutil@4.1.0)(typescript@5.9.3)(utf-8-validate@5.0.10))(bs58@5.0.0)':
     dependencies:
-      type-detect: 4.0.8
+      '@solana/wallet-adapter-base': 0.9.27(@solana/web3.js@1.98.4(bufferutil@4.1.0)(typescript@5.9.3)(utf-8-validate@5.0.10))
+      '@solana/wallet-standard-chains': 1.1.1
+      '@solana/wallet-standard-features': 1.3.0
+      '@solana/wallet-standard-util': 1.1.2
+      '@solana/web3.js': 1.98.4(bufferutil@4.1.0)(typescript@5.9.3)(utf-8-validate@5.0.10)
+      '@wallet-standard/app': 1.1.0
+      '@wallet-standard/base': 1.1.0
+      '@wallet-standard/features': 1.1.0
+      '@wallet-standard/wallet': 1.1.0
+      bs58: 5.0.0
 
-  '@sinonjs/fake-timers@10.3.0':
+  '@solana/wallet-standard-wallet-adapter-react@1.1.4(@solana/wallet-adapter-base@0.9.27(@solana/web3.js@1.98.4(bufferutil@4.1.0)(typescript@5.9.3)(utf-8-validate@5.0.10)))(@solana/web3.js@1.98.4(bufferutil@4.1.0)(typescript@5.9.3)(utf-8-validate@5.0.10))(bs58@5.0.0)(react@19.1.0)':
     dependencies:
-      '@sinonjs/commons': 3.0.1
+      '@solana/wallet-adapter-base': 0.9.27(@solana/web3.js@1.98.4(bufferutil@4.1.0)(typescript@5.9.3)(utf-8-validate@5.0.10))
+      '@solana/wallet-standard-wallet-adapter-base': 1.1.4(@solana/web3.js@1.98.4(bufferutil@4.1.0)(typescript@5.9.3)(utf-8-validate@5.0.10))(bs58@5.0.0)
+      '@wallet-standard/app': 1.1.0
+      '@wallet-standard/base': 1.1.0
+      react: 19.1.0
+    transitivePeerDependencies:
+      - '@solana/web3.js'
+      - bs58
+
+  '@solana/wallet-standard-wallet-adapter@1.1.4(@solana/wallet-adapter-base@0.9.27(@solana/web3.js@1.98.4(bufferutil@4.1.0)(typescript@5.9.3)(utf-8-validate@5.0.10)))(@solana/web3.js@1.98.4(bufferutil@4.1.0)(typescript@5.9.3)(utf-8-validate@5.0.10))(bs58@5.0.0)(react@19.1.0)':
+    dependencies:
+      '@solana/wallet-standard-wallet-adapter-base': 1.1.4(@solana/web3.js@1.98.4(bufferutil@4.1.0)(typescript@5.9.3)(utf-8-validate@5.0.10))(bs58@5.0.0)
+      '@solana/wallet-standard-wallet-adapter-react': 1.1.4(@solana/wallet-adapter-base@0.9.27(@solana/web3.js@1.98.4(bufferutil@4.1.0)(typescript@5.9.3)(utf-8-validate@5.0.10)))(@solana/web3.js@1.98.4(bufferutil@4.1.0)(typescript@5.9.3)(utf-8-validate@5.0.10))(bs58@5.0.0)(react@19.1.0)
+    transitivePeerDependencies:
+      - '@solana/wallet-adapter-base'
+      - '@solana/web3.js'
+      - bs58
+      - react
+
+  '@solana/wallet-standard@1.1.4(@solana/wallet-adapter-base@0.9.27(@solana/web3.js@1.98.4(bufferutil@4.1.0)(typescript@5.9.3)(utf-8-validate@5.0.10)))(@solana/web3.js@1.98.4(bufferutil@4.1.0)(typescript@5.9.3)(utf-8-validate@5.0.10))(bs58@5.0.0)(react@19.1.0)':
+    dependencies:
+      '@solana/wallet-standard-core': 1.1.2
+      '@solana/wallet-standard-wallet-adapter': 1.1.4(@solana/wallet-adapter-base@0.9.27(@solana/web3.js@1.98.4(bufferutil@4.1.0)(typescript@5.9.3)(utf-8-validate@5.0.10)))(@solana/web3.js@1.98.4(bufferutil@4.1.0)(typescript@5.9.3)(utf-8-validate@5.0.10))(bs58@5.0.0)(react@19.1.0)
+    transitivePeerDependencies:
+      - '@solana/wallet-adapter-base'
+      - '@solana/web3.js'
+      - bs58
+      - react
+
+  '@solana/web3.js@1.98.4(bufferutil@4.1.0)(typescript@5.9.3)(utf-8-validate@5.0.10)':
+    dependencies:
+      '@babel/runtime': 7.28.6
+      '@noble/curves': 1.9.7
+      '@noble/hashes': 1.8.0
+      '@solana/buffer-layout': 4.0.1
+      '@solana/codecs-numbers': 2.3.0(typescript@5.9.3)
+      agentkeepalive: 4.6.0
+      bn.js: 5.2.3
+      borsh: 0.7.0
+      bs58: 4.0.1
+      buffer: 6.0.3
+      fast-stable-stringify: 1.0.0
+      jayson: 4.3.0(bufferutil@4.1.0)(utf-8-validate@5.0.10)
+      node-fetch: 2.7.0
+      rpc-websockets: 9.3.3
+      superstruct: 2.0.2
+    transitivePeerDependencies:
+      - bufferutil
+      - encoding
+      - typescript
+      - utf-8-validate
 
   '@swc/helpers@0.5.15':
     dependencies:
@@ -5608,6 +6725,17 @@ snapshots:
     dependencies:
       '@babel/types': 7.29.0
 
+  '@types/chai@5.2.3':
+    dependencies:
+      '@types/deep-eql': 4.0.2
+      assertion-error: 2.0.1
+
+  '@types/connect@3.4.38':
+    dependencies:
+      '@types/node': 20.19.33
+
+  '@types/deep-eql@4.0.2': {}
+
   '@types/estree@1.0.8': {}
 
   '@types/graceful-fs@4.1.9':
@@ -5628,6 +6756,8 @@ snapshots:
 
   '@types/json5@0.0.29': {}
 
+  '@types/node@12.20.55': {}
+
   '@types/node@20.19.33':
     dependencies:
       undici-types: 6.21.0
@@ -5646,6 +6776,16 @@ snapshots:
 
   '@types/stack-utils@2.0.3': {}
 
+  '@types/uuid@8.3.4': {}
+
+  '@types/ws@7.4.7':
+    dependencies:
+      '@types/node': 20.19.33
+
+  '@types/ws@8.18.1':
+    dependencies:
+      '@types/node': 20.19.33
+
   '@types/yargs-parser@21.0.3': {}
 
   '@types/yargs@17.0.35':
@@ -5816,6 +6956,75 @@ snapshots:
       '@urql/core': 5.2.0
       wonka: 6.3.5
 
+  '@vitest/expect@3.2.4':
+    dependencies:
+      '@types/chai': 5.2.3
+      '@vitest/spy': 3.2.4
+      '@vitest/utils': 3.2.4
+      chai: 5.3.3
+      tinyrainbow: 2.0.0
+
+  '@vitest/mocker@3.2.4(vite@7.3.1(@types/node@20.19.33)(jiti@2.6.1)(lightningcss@1.31.1)(terser@5.46.0)(yaml@2.8.2))':
+    dependencies:
+      '@vitest/spy': 3.2.4
+      estree-walker: 3.0.3
+      magic-string: 0.30.21
+    optionalDependencies:
+      vite: 7.3.1(@types/node@20.19.33)(jiti@2.6.1)(lightningcss@1.31.1)(terser@5.46.0)(yaml@2.8.2)
+
+  '@vitest/pretty-format@3.2.4':
+    dependencies:
+      tinyrainbow: 2.0.0
+
+  '@vitest/runner@3.2.4':
+    dependencies:
+      '@vitest/utils': 3.2.4
+      pathe: 2.0.3
+      strip-literal: 3.1.0
+
+  '@vitest/snapshot@3.2.4':
+    dependencies:
+      '@vitest/pretty-format': 3.2.4
+      magic-string: 0.30.21
+      pathe: 2.0.3
+
+  '@vitest/spy@3.2.4':
+    dependencies:
+      tinyspy: 4.0.4
+
+  '@vitest/utils@3.2.4':
+    dependencies:
+      '@vitest/pretty-format': 3.2.4
+      loupe: 3.2.1
+      tinyrainbow: 2.0.0
+
+  '@wallet-standard/app@1.1.0':
+    dependencies:
+      '@wallet-standard/base': 1.1.0
+
+  '@wallet-standard/base@1.1.0': {}
+
+  '@wallet-standard/core@1.1.1':
+    dependencies:
+      '@wallet-standard/app': 1.1.0
+      '@wallet-standard/base': 1.1.0
+      '@wallet-standard/errors': 0.1.1
+      '@wallet-standard/features': 1.1.0
+      '@wallet-standard/wallet': 1.1.0
+
+  '@wallet-standard/errors@0.1.1':
+    dependencies:
+      chalk: 5.6.2
+      commander: 13.1.0
+
+  '@wallet-standard/features@1.1.0':
+    dependencies:
+      '@wallet-standard/base': 1.1.0
+
+  '@wallet-standard/wallet@1.1.0':
+    dependencies:
+      '@wallet-standard/base': 1.1.0
+
   '@xmldom/xmldom@0.8.11': {}
 
   abort-controller@3.0.0:
@@ -5840,6 +7049,10 @@ snapshots:
 
   agent-base@7.1.4: {}
 
+  agentkeepalive@4.6.0:
+    dependencies:
+      humanize-ms: 1.2.1
+
   ajv@6.14.0:
     dependencies:
       fast-deep-equal: 3.1.3
@@ -5953,6 +7166,8 @@ snapshots:
 
   asap@2.0.6: {}
 
+  assertion-error@2.0.1: {}
+
   ast-types-flow@0.0.8: {}
 
   async-function@1.0.0: {}
@@ -6056,7 +7271,7 @@ snapshots:
       '@babel/plugin-syntax-private-property-in-object': 7.14.5(@babel/core@7.29.0)
       '@babel/plugin-syntax-top-level-await': 7.14.5(@babel/core@7.29.0)
 
-  babel-preset-expo@54.0.10(@babel/core@7.29.0)(@babel/runtime@7.28.6)(expo@54.0.33(@babel/core@7.29.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0))(react-refresh@0.14.2):
+  babel-preset-expo@54.0.10(@babel/core@7.29.0)(@babel/runtime@7.28.6)(expo@54.0.33(@babel/core@7.29.0)(bufferutil@4.1.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)(utf-8-validate@5.0.10))(react-refresh@0.14.2):
     dependencies:
       '@babel/helper-module-imports': 7.28.6
       '@babel/plugin-proposal-decorators': 7.29.0(@babel/core@7.29.0)
@@ -6083,7 +7298,7 @@ snapshots:
       resolve-from: 5.0.0
     optionalDependencies:
       '@babel/runtime': 7.28.6
-      expo: 54.0.33(@babel/core@7.29.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0)
+      expo: 54.0.33(@babel/core@7.29.0)(bufferutil@4.1.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)(utf-8-validate@5.0.10)
     transitivePeerDependencies:
       - '@babel/core'
       - supports-color
@@ -6098,6 +7313,14 @@ snapshots:
 
   balanced-match@4.0.3: {}
 
+  base-x@3.0.11:
+    dependencies:
+      safe-buffer: 5.2.1
+
+  base-x@4.0.1: {}
+
+  base-x@5.0.1: {}
+
   base64-js@1.5.1: {}
 
   baseline-browser-mapping@2.10.0: {}
@@ -6108,6 +7331,14 @@ snapshots:
 
   big-integer@1.6.52: {}
 
+  bn.js@5.2.3: {}
+
+  borsh@0.7.0:
+    dependencies:
+      bn.js: 5.2.3
+      bs58: 4.0.1
+      text-encoding-utf-8: 1.0.2
+
   bplist-creator@0.1.0:
     dependencies:
       stream-buffers: 2.2.0
@@ -6145,6 +7376,18 @@ snapshots:
       node-releases: 2.0.27
       update-browserslist-db: 1.2.3(browserslist@4.28.1)
 
+  bs58@4.0.1:
+    dependencies:
+      base-x: 3.0.11
+
+  bs58@5.0.0:
+    dependencies:
+      base-x: 4.0.1
+
+  bs58@6.0.0:
+    dependencies:
+      base-x: 5.0.1
+
   bser@2.1.1:
     dependencies:
       node-int64: 0.4.0
@@ -6156,8 +7399,20 @@ snapshots:
       base64-js: 1.5.1
       ieee754: 1.2.1
 
+  buffer@6.0.3:
+    dependencies:
+      base64-js: 1.5.1
+      ieee754: 1.2.1
+
+  bufferutil@4.1.0:
+    dependencies:
+      node-gyp-build: 4.8.4
+    optional: true
+
   bytes@3.1.2: {}
 
+  cac@6.7.14: {}
+
   call-bind-apply-helpers@1.0.2:
     dependencies:
       es-errors: 1.3.0
@@ -6183,6 +7438,14 @@ snapshots:
 
   caniuse-lite@1.0.30001770: {}
 
+  chai@5.3.3:
+    dependencies:
+      assertion-error: 2.0.1
+      check-error: 2.1.3
+      deep-eql: 5.0.2
+      loupe: 3.2.1
+      pathval: 2.0.1
+
   chalk@2.4.2:
     dependencies:
       ansi-styles: 3.2.1
@@ -6194,6 +7457,10 @@ snapshots:
       ansi-styles: 4.3.0
       supports-color: 7.2.0
 
+  chalk@5.6.2: {}
+
+  check-error@2.1.3: {}
+
   chownr@3.0.0: {}
 
   chrome-launcher@0.15.2:
@@ -6250,6 +7517,12 @@ snapshots:
 
   commander@12.1.0: {}
 
+  commander@13.1.0: {}
+
+  commander@14.0.1: {}
+
+  commander@14.0.3: {}
+
   commander@2.20.3: {}
 
   commander@4.1.1: {}
@@ -6341,6 +7614,8 @@ snapshots:
     dependencies:
       ms: 2.1.3
 
+  deep-eql@5.0.2: {}
+
   deep-extend@0.6.0: {}
 
   deep-is@0.1.4: {}
@@ -6365,6 +7640,8 @@ snapshots:
       has-property-descriptors: 1.0.2
       object-keys: 1.1.1
 
+  delay@5.0.0: {}
+
   depd@2.0.0: {}
 
   destroy@1.2.0: {}
@@ -6490,6 +7767,8 @@ snapshots:
       iterator.prototype: 1.1.5
       safe-array-concat: 1.1.3
 
+  es-module-lexer@1.7.0: {}
+
   es-object-atoms@1.1.1:
     dependencies:
       es-errors: 1.3.0
@@ -6511,6 +7790,41 @@ snapshots:
       is-date-object: 1.1.0
       is-symbol: 1.1.1
 
+  es6-promise@4.2.8: {}
+
+  es6-promisify@5.0.0:
+    dependencies:
+      es6-promise: 4.2.8
+
+  esbuild@0.27.3:
+    optionalDependencies:
+      '@esbuild/aix-ppc64': 0.27.3
+      '@esbuild/android-arm': 0.27.3
+      '@esbuild/android-arm64': 0.27.3
+      '@esbuild/android-x64': 0.27.3
+      '@esbuild/darwin-arm64': 0.27.3
+      '@esbuild/darwin-x64': 0.27.3
+      '@esbuild/freebsd-arm64': 0.27.3
+      '@esbuild/freebsd-x64': 0.27.3
+      '@esbuild/linux-arm': 0.27.3
+      '@esbuild/linux-arm64': 0.27.3
+      '@esbuild/linux-ia32': 0.27.3
+      '@esbuild/linux-loong64': 0.27.3
+      '@esbuild/linux-mips64el': 0.27.3
+      '@esbuild/linux-ppc64': 0.27.3
+      '@esbuild/linux-riscv64': 0.27.3
+      '@esbuild/linux-s390x': 0.27.3
+      '@esbuild/linux-x64': 0.27.3
+      '@esbuild/netbsd-arm64': 0.27.3
+      '@esbuild/netbsd-x64': 0.27.3
+      '@esbuild/openbsd-arm64': 0.27.3
+      '@esbuild/openbsd-x64': 0.27.3
+      '@esbuild/openharmony-arm64': 0.27.3
+      '@esbuild/sunos-x64': 0.27.3
+      '@esbuild/win32-arm64': 0.27.3
+      '@esbuild/win32-ia32': 0.27.3
+      '@esbuild/win32-x64': 0.27.3
+
   escalade@3.2.0: {}
 
   escape-html@1.0.3: {}
@@ -6756,48 +8070,56 @@ snapshots:
 
   estraverse@5.3.0: {}
 
+  estree-walker@3.0.3:
+    dependencies:
+      '@types/estree': 1.0.8
+
   esutils@2.0.3: {}
 
   etag@1.8.1: {}
 
   event-target-shim@5.0.1: {}
 
+  eventemitter3@5.0.4: {}
+
   exec-async@2.2.0: {}
 
-  expo-asset@12.0.12(expo@54.0.33(@babel/core@7.29.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0))(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0):
+  expect-type@1.3.0: {}
+
+  expo-asset@12.0.12(expo@54.0.33(@babel/core@7.29.0)(bufferutil@4.1.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)(utf-8-validate@5.0.10))(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0):
     dependencies:
       '@expo/image-utils': 0.8.8
-      expo: 54.0.33(@babel/core@7.29.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0)
-      expo-constants: 18.0.13(expo@54.0.33(@babel/core@7.29.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0))(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))
+      expo: 54.0.33(@babel/core@7.29.0)(bufferutil@4.1.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)(utf-8-validate@5.0.10)
+      expo-constants: 18.0.13(expo@54.0.33(@babel/core@7.29.0)(bufferutil@4.1.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)(utf-8-validate@5.0.10))(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))
       react: 19.1.0
-      react-native: 0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0)
+      react-native: 0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10)
     transitivePeerDependencies:
       - supports-color
 
-  expo-constants@18.0.13(expo@54.0.33(@babel/core@7.29.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0))(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0)):
+  expo-constants@18.0.13(expo@54.0.33(@babel/core@7.29.0)(bufferutil@4.1.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)(utf-8-validate@5.0.10))(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10)):
     dependencies:
       '@expo/config': 12.0.13
       '@expo/env': 2.0.8
-      expo: 54.0.33(@babel/core@7.29.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0)
-      react-native: 0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0)
+      expo: 54.0.33(@babel/core@7.29.0)(bufferutil@4.1.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)(utf-8-validate@5.0.10)
+      react-native: 0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10)
     transitivePeerDependencies:
       - supports-color
 
-  expo-file-system@19.0.21(expo@54.0.33(@babel/core@7.29.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0))(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0)):
+  expo-file-system@19.0.21(expo@54.0.33(@babel/core@7.29.0)(bufferutil@4.1.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)(utf-8-validate@5.0.10))(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10)):
     dependencies:
-      expo: 54.0.33(@babel/core@7.29.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0)
-      react-native: 0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0)
+      expo: 54.0.33(@babel/core@7.29.0)(bufferutil@4.1.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)(utf-8-validate@5.0.10)
+      react-native: 0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10)
 
-  expo-font@14.0.11(expo@54.0.33(@babel/core@7.29.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0))(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0):
+  expo-font@14.0.11(expo@54.0.33(@babel/core@7.29.0)(bufferutil@4.1.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)(utf-8-validate@5.0.10))(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0):
     dependencies:
-      expo: 54.0.33(@babel/core@7.29.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0)
+      expo: 54.0.33(@babel/core@7.29.0)(bufferutil@4.1.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)(utf-8-validate@5.0.10)
       fontfaceobserver: 2.3.0
       react: 19.1.0
-      react-native: 0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0)
+      react-native: 0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10)
 
-  expo-keep-awake@15.0.8(expo@54.0.33(@babel/core@7.29.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0))(react@19.1.0):
+  expo-keep-awake@15.0.8(expo@54.0.33(@babel/core@7.29.0)(bufferutil@4.1.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0):
     dependencies:
-      expo: 54.0.33(@babel/core@7.29.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0)
+      expo: 54.0.33(@babel/core@7.29.0)(bufferutil@4.1.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)(utf-8-validate@5.0.10)
       react: 19.1.0
 
   expo-modules-autolinking@3.0.24:
@@ -6808,43 +8130,43 @@ snapshots:
       require-from-string: 2.0.2
       resolve-from: 5.0.0
 
-  expo-modules-core@3.0.29(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0):
+  expo-modules-core@3.0.29(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0):
     dependencies:
       invariant: 2.2.4
       react: 19.1.0
-      react-native: 0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0)
+      react-native: 0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10)
 
   expo-server@1.0.5: {}
 
-  expo-status-bar@3.0.9(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0):
+  expo-status-bar@3.0.9(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0):
     dependencies:
       react: 19.1.0
-      react-native: 0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0)
-      react-native-is-edge-to-edge: 1.2.1(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0)
+      react-native: 0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10)
+      react-native-is-edge-to-edge: 1.2.1(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)
 
-  expo@54.0.33(@babel/core@7.29.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0):
+  expo@54.0.33(@babel/core@7.29.0)(bufferutil@4.1.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)(utf-8-validate@5.0.10):
     dependencies:
       '@babel/runtime': 7.28.6
-      '@expo/cli': 54.0.23(expo@54.0.33(@babel/core@7.29.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0))(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))
+      '@expo/cli': 54.0.23(bufferutil@4.1.0)(expo@54.0.33(@babel/core@7.29.0)(bufferutil@4.1.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)(utf-8-validate@5.0.10))(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(utf-8-validate@5.0.10)
       '@expo/config': 12.0.13
       '@expo/config-plugins': 54.0.4
-      '@expo/devtools': 0.1.8(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0)
+      '@expo/devtools': 0.1.8(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)
       '@expo/fingerprint': 0.15.4
-      '@expo/metro': 54.2.0
-      '@expo/metro-config': 54.0.14(expo@54.0.33(@babel/core@7.29.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0))
-      '@expo/vector-icons': 15.0.3(expo-font@14.0.11(expo@54.0.33(@babel/core@7.29.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0))(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0))(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0)
+      '@expo/metro': 54.2.0(bufferutil@4.1.0)(utf-8-validate@5.0.10)
+      '@expo/metro-config': 54.0.14(bufferutil@4.1.0)(expo@54.0.33(@babel/core@7.29.0)(bufferutil@4.1.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)(utf-8-validate@5.0.10))(utf-8-validate@5.0.10)
+      '@expo/vector-icons': 15.0.3(expo-font@14.0.11(expo@54.0.33(@babel/core@7.29.0)(bufferutil@4.1.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)(utf-8-validate@5.0.10))(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0))(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)
       '@ungap/structured-clone': 1.3.0
-      babel-preset-expo: 54.0.10(@babel/core@7.29.0)(@babel/runtime@7.28.6)(expo@54.0.33(@babel/core@7.29.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0))(react-refresh@0.14.2)
-      expo-asset: 12.0.12(expo@54.0.33(@babel/core@7.29.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0))(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0)
-      expo-constants: 18.0.13(expo@54.0.33(@babel/core@7.29.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0))(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))
-      expo-file-system: 19.0.21(expo@54.0.33(@babel/core@7.29.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0))(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))
-      expo-font: 14.0.11(expo@54.0.33(@babel/core@7.29.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0))(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0)
-      expo-keep-awake: 15.0.8(expo@54.0.33(@babel/core@7.29.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0))(react@19.1.0)
+      babel-preset-expo: 54.0.10(@babel/core@7.29.0)(@babel/runtime@7.28.6)(expo@54.0.33(@babel/core@7.29.0)(bufferutil@4.1.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)(utf-8-validate@5.0.10))(react-refresh@0.14.2)
+      expo-asset: 12.0.12(expo@54.0.33(@babel/core@7.29.0)(bufferutil@4.1.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)(utf-8-validate@5.0.10))(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)
+      expo-constants: 18.0.13(expo@54.0.33(@babel/core@7.29.0)(bufferutil@4.1.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)(utf-8-validate@5.0.10))(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))
+      expo-file-system: 19.0.21(expo@54.0.33(@babel/core@7.29.0)(bufferutil@4.1.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)(utf-8-validate@5.0.10))(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))
+      expo-font: 14.0.11(expo@54.0.33(@babel/core@7.29.0)(bufferutil@4.1.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)(utf-8-validate@5.0.10))(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)
+      expo-keep-awake: 15.0.8(expo@54.0.33(@babel/core@7.29.0)(bufferutil@4.1.0)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)
       expo-modules-autolinking: 3.0.24
-      expo-modules-core: 3.0.29(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0)
+      expo-modules-core: 3.0.29(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)
       pretty-format: 29.7.0
       react: 19.1.0
-      react-native: 0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0)
+      react-native: 0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10)
       react-refresh: 0.14.2
       whatwg-url-without-unicode: 8.0.0-3
     transitivePeerDependencies:
@@ -6857,6 +8179,8 @@ snapshots:
 
   exponential-backoff@3.1.3: {}
 
+  eyes@0.1.8: {}
+
   fast-deep-equal@3.1.3: {}
 
   fast-glob@3.3.1:
@@ -6871,6 +8195,10 @@ snapshots:
 
   fast-levenshtein@2.0.6: {}
 
+  fast-stable-stringify@1.0.0: {}
+
+  fastestsmallesttextencoderdecoder@1.0.22: {}
+
   fastq@1.20.1:
     dependencies:
       reusify: 1.1.0
@@ -7109,6 +8437,10 @@ snapshots:
     transitivePeerDependencies:
       - supports-color
 
+  humanize-ms@1.2.1:
+    dependencies:
+      ms: 2.1.3
+
   hyphenate-style-name@1.1.0: {}
 
   ieee754@1.2.1: {}
@@ -7275,6 +8607,10 @@ snapshots:
 
   isexe@2.0.0: {}
 
+  isomorphic-ws@4.0.1(ws@7.5.10(bufferutil@4.1.0)(utf-8-validate@5.0.10)):
+    dependencies:
+      ws: 7.5.10(bufferutil@4.1.0)(utf-8-validate@5.0.10)
+
   istanbul-lib-coverage@3.2.2: {}
 
   istanbul-lib-instrument@5.2.1:
@@ -7296,6 +8632,24 @@ snapshots:
       has-symbols: 1.1.0
       set-function-name: 2.0.2
 
+  jayson@4.3.0(bufferutil@4.1.0)(utf-8-validate@5.0.10):
+    dependencies:
+      '@types/connect': 3.4.38
+      '@types/node': 12.20.55
+      '@types/ws': 7.4.7
+      commander: 2.20.3
+      delay: 5.0.0
+      es6-promisify: 5.0.0
+      eyes: 0.1.8
+      isomorphic-ws: 4.0.1(ws@7.5.10(bufferutil@4.1.0)(utf-8-validate@5.0.10))
+      json-stringify-safe: 5.0.1
+      stream-json: 1.9.1
+      uuid: 8.3.2
+      ws: 7.5.10(bufferutil@4.1.0)(utf-8-validate@5.0.10)
+    transitivePeerDependencies:
+      - bufferutil
+      - utf-8-validate
+
   jest-environment-node@29.7.0:
     dependencies:
       '@jest/environment': 29.7.0
@@ -7372,8 +8726,12 @@ snapshots:
 
   jiti@2.6.1: {}
 
+  js-base64@3.7.8: {}
+
   js-tokens@4.0.0: {}
 
+  js-tokens@9.0.1: {}
+
   js-yaml@3.14.2:
     dependencies:
       argparse: 1.0.10
@@ -7393,6 +8751,8 @@ snapshots:
 
   json-stable-stringify-without-jsonify@1.0.1: {}
 
+  json-stringify-safe@5.0.1: {}
+
   json5@1.0.2:
     dependencies:
       minimist: 1.2.8
@@ -7507,6 +8867,8 @@ snapshots:
     dependencies:
       js-tokens: 4.0.0
 
+  loupe@3.2.1: {}
+
   lru-cache@10.4.3: {}
 
   lru-cache@11.2.6: {}
@@ -7579,12 +8941,12 @@ snapshots:
     transitivePeerDependencies:
       - supports-color
 
-  metro-config@0.83.3:
+  metro-config@0.83.3(bufferutil@4.1.0)(utf-8-validate@5.0.10):
     dependencies:
       connect: 3.7.0
       flow-enums-runtime: 0.0.6
       jest-validate: 29.7.0
-      metro: 0.83.3
+      metro: 0.83.3(bufferutil@4.1.0)(utf-8-validate@5.0.10)
       metro-cache: 0.83.3
       metro-core: 0.83.3
       metro-runtime: 0.83.3
@@ -7594,12 +8956,12 @@ snapshots:
       - supports-color
       - utf-8-validate
 
-  metro-config@0.83.4:
+  metro-config@0.83.4(bufferutil@4.1.0)(utf-8-validate@5.0.10):
     dependencies:
       connect: 3.7.0
       flow-enums-runtime: 0.0.6
       jest-validate: 29.7.0
-      metro: 0.83.4
+      metro: 0.83.4(bufferutil@4.1.0)(utf-8-validate@5.0.10)
       metro-cache: 0.83.4
       metro-core: 0.83.4
       metro-runtime: 0.83.4
@@ -7750,14 +9112,14 @@ snapshots:
     transitivePeerDependencies:
       - supports-color
 
-  metro-transform-worker@0.83.3:
+  metro-transform-worker@0.83.3(bufferutil@4.1.0)(utf-8-validate@5.0.10):
     dependencies:
       '@babel/core': 7.29.0
       '@babel/generator': 7.29.1
       '@babel/parser': 7.29.0
       '@babel/types': 7.29.0
       flow-enums-runtime: 0.0.6
-      metro: 0.83.3
+      metro: 0.83.3(bufferutil@4.1.0)(utf-8-validate@5.0.10)
       metro-babel-transformer: 0.83.3
       metro-cache: 0.83.3
       metro-cache-key: 0.83.3
@@ -7770,14 +9132,14 @@ snapshots:
       - supports-color
       - utf-8-validate
 
-  metro-transform-worker@0.83.4:
+  metro-transform-worker@0.83.4(bufferutil@4.1.0)(utf-8-validate@5.0.10):
     dependencies:
       '@babel/core': 7.29.0
       '@babel/generator': 7.29.1
       '@babel/parser': 7.29.0
       '@babel/types': 7.29.0
       flow-enums-runtime: 0.0.6
-      metro: 0.83.4
+      metro: 0.83.4(bufferutil@4.1.0)(utf-8-validate@5.0.10)
       metro-babel-transformer: 0.83.4
       metro-cache: 0.83.4
       metro-cache-key: 0.83.4
@@ -7790,7 +9152,7 @@ snapshots:
       - supports-color
       - utf-8-validate
 
-  metro@0.83.3:
+  metro@0.83.3(bufferutil@4.1.0)(utf-8-validate@5.0.10):
     dependencies:
       '@babel/code-frame': 7.29.0
       '@babel/core': 7.29.0
@@ -7816,7 +9178,7 @@ snapshots:
       metro-babel-transformer: 0.83.3
       metro-cache: 0.83.3
       metro-cache-key: 0.83.3
-      metro-config: 0.83.3
+      metro-config: 0.83.3(bufferutil@4.1.0)(utf-8-validate@5.0.10)
       metro-core: 0.83.3
       metro-file-map: 0.83.3
       metro-resolver: 0.83.3
@@ -7824,20 +9186,20 @@ snapshots:
       metro-source-map: 0.83.3
       metro-symbolicate: 0.83.3
       metro-transform-plugins: 0.83.3
-      metro-transform-worker: 0.83.3
+      metro-transform-worker: 0.83.3(bufferutil@4.1.0)(utf-8-validate@5.0.10)
       mime-types: 2.1.35
       nullthrows: 1.1.1
       serialize-error: 2.1.0
       source-map: 0.5.7
       throat: 5.0.0
-      ws: 7.5.10
+      ws: 7.5.10(bufferutil@4.1.0)(utf-8-validate@5.0.10)
       yargs: 17.7.2
     transitivePeerDependencies:
       - bufferutil
       - supports-color
       - utf-8-validate
 
-  metro@0.83.4:
+  metro@0.83.4(bufferutil@4.1.0)(utf-8-validate@5.0.10):
     dependencies:
       '@babel/code-frame': 7.29.0
       '@babel/core': 7.29.0
@@ -7863,7 +9225,7 @@ snapshots:
       metro-babel-transformer: 0.83.4
       metro-cache: 0.83.4
       metro-cache-key: 0.83.4
-      metro-config: 0.83.4
+      metro-config: 0.83.4(bufferutil@4.1.0)(utf-8-validate@5.0.10)
       metro-core: 0.83.4
       metro-file-map: 0.83.4
       metro-resolver: 0.83.4
@@ -7871,13 +9233,13 @@ snapshots:
       metro-source-map: 0.83.4
       metro-symbolicate: 0.83.4
       metro-transform-plugins: 0.83.4
-      metro-transform-worker: 0.83.4
+      metro-transform-worker: 0.83.4(bufferutil@4.1.0)(utf-8-validate@5.0.10)
       mime-types: 3.0.2
       nullthrows: 1.1.1
       serialize-error: 2.1.0
       source-map: 0.5.7
       throat: 5.0.0
-      ws: 7.5.10
+      ws: 7.5.10(bufferutil@4.1.0)(utf-8-validate@5.0.10)
       yargs: 17.7.2
     transitivePeerDependencies:
       - bufferutil
@@ -7989,6 +9351,9 @@ snapshots:
 
   node-forge@1.3.3: {}
 
+  node-gyp-build@4.8.4:
+    optional: true
+
   node-int64@0.4.0: {}
 
   node-releases@2.0.27: {}
@@ -8148,6 +9513,10 @@ snapshots:
       lru-cache: 11.2.6
       minipass: 7.1.3
 
+  pathe@2.0.3: {}
+
+  pathval@2.0.1: {}
+
   picocolors@1.1.1: {}
 
   picomatch@2.3.1: {}
@@ -8240,10 +9609,10 @@ snapshots:
       minimist: 1.2.8
       strip-json-comments: 2.0.1
 
-  react-devtools-core@6.1.5:
+  react-devtools-core@6.1.5(bufferutil@4.1.0)(utf-8-validate@5.0.10):
     dependencies:
       shell-quote: 1.8.3
-      ws: 7.5.10
+      ws: 7.5.10(bufferutil@4.1.0)(utf-8-validate@5.0.10)
     transitivePeerDependencies:
       - bufferutil
       - utf-8-validate
@@ -8262,10 +9631,10 @@ snapshots:
 
   react-is@18.3.1: {}
 
-  react-native-is-edge-to-edge@1.2.1(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0):
+  react-native-is-edge-to-edge@1.2.1(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0):
     dependencies:
       react: 19.1.0
-      react-native: 0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0)
+      react-native: 0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10)
 
   react-native-web@0.21.2(react-dom@19.1.0(react@19.1.0))(react@19.1.0):
     dependencies:
@@ -8282,16 +9651,16 @@ snapshots:
     transitivePeerDependencies:
       - encoding
 
-  react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0):
+  react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10):
     dependencies:
       '@jest/create-cache-key-function': 29.7.0
       '@react-native/assets-registry': 0.81.5
       '@react-native/codegen': 0.81.5(@babel/core@7.29.0)
-      '@react-native/community-cli-plugin': 0.81.5
+      '@react-native/community-cli-plugin': 0.81.5(bufferutil@4.1.0)(utf-8-validate@5.0.10)
       '@react-native/gradle-plugin': 0.81.5
       '@react-native/js-polyfills': 0.81.5
       '@react-native/normalize-colors': 0.81.5
-      '@react-native/virtualized-lists': 0.81.5(@types/react@19.1.17)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(react@19.1.0))(react@19.1.0)
+      '@react-native/virtualized-lists': 0.81.5(@types/react@19.1.17)(react-native@0.81.5(@babel/core@7.29.0)(@types/react@19.1.17)(bufferutil@4.1.0)(react@19.1.0)(utf-8-validate@5.0.10))(react@19.1.0)
       abort-controller: 3.0.0
       anser: 1.4.10
       ansi-regex: 5.0.1
@@ -8310,14 +9679,14 @@ snapshots:
       pretty-format: 29.7.0
       promise: 8.3.0
       react: 19.1.0
-      react-devtools-core: 6.1.5
+      react-devtools-core: 6.1.5(bufferutil@4.1.0)(utf-8-validate@5.0.10)
       react-refresh: 0.14.2
       regenerator-runtime: 0.13.11
       scheduler: 0.26.0
       semver: 7.7.4
       stacktrace-parser: 0.1.11
       whatwg-fetch: 3.6.20
-      ws: 6.2.3
+      ws: 6.2.3(bufferutil@4.1.0)(utf-8-validate@5.0.10)
       yargs: 17.7.2
     optionalDependencies:
       '@types/react': 19.1.17
@@ -8432,6 +9801,50 @@ snapshots:
     dependencies:
       glob: 7.2.3
 
+  rollup@4.58.0:
+    dependencies:
+      '@types/estree': 1.0.8
+    optionalDependencies:
+      '@rollup/rollup-android-arm-eabi': 4.58.0
+      '@rollup/rollup-android-arm64': 4.58.0
+      '@rollup/rollup-darwin-arm64': 4.58.0
+      '@rollup/rollup-darwin-x64': 4.58.0
+      '@rollup/rollup-freebsd-arm64': 4.58.0
+      '@rollup/rollup-freebsd-x64': 4.58.0
+      '@rollup/rollup-linux-arm-gnueabihf': 4.58.0
+      '@rollup/rollup-linux-arm-musleabihf': 4.58.0
+      '@rollup/rollup-linux-arm64-gnu': 4.58.0
+      '@rollup/rollup-linux-arm64-musl': 4.58.0
+      '@rollup/rollup-linux-loong64-gnu': 4.58.0
+      '@rollup/rollup-linux-loong64-musl': 4.58.0
+      '@rollup/rollup-linux-ppc64-gnu': 4.58.0
+      '@rollup/rollup-linux-ppc64-musl': 4.58.0
+      '@rollup/rollup-linux-riscv64-gnu': 4.58.0
+      '@rollup/rollup-linux-riscv64-musl': 4.58.0
+      '@rollup/rollup-linux-s390x-gnu': 4.58.0
+      '@rollup/rollup-linux-x64-gnu': 4.58.0
+      '@rollup/rollup-linux-x64-musl': 4.58.0
+      '@rollup/rollup-openbsd-x64': 4.58.0
+      '@rollup/rollup-openharmony-arm64': 4.58.0
+      '@rollup/rollup-win32-arm64-msvc': 4.58.0
+      '@rollup/rollup-win32-ia32-msvc': 4.58.0
+      '@rollup/rollup-win32-x64-gnu': 4.58.0
+      '@rollup/rollup-win32-x64-msvc': 4.58.0
+      fsevents: 2.3.3
+
+  rpc-websockets@9.3.3:
+    dependencies:
+      '@swc/helpers': 0.5.15
+      '@types/uuid': 8.3.4
+      '@types/ws': 8.18.1
+      buffer: 6.0.3
+      eventemitter3: 5.0.4
+      uuid: 8.3.2
+      ws: 8.19.0(bufferutil@4.1.0)(utf-8-validate@5.0.10)
+    optionalDependencies:
+      bufferutil: 4.1.0
+      utf-8-validate: 5.0.10
+
   run-parallel@1.2.0:
     dependencies:
       queue-microtask: 1.2.3
@@ -8590,6 +10003,8 @@ snapshots:
       side-channel-map: 1.0.1
       side-channel-weakmap: 1.0.2
 
+  siginfo@2.0.0: {}
+
   signal-exit@3.0.7: {}
 
   simple-plist@1.3.1:
@@ -8623,6 +10038,8 @@ snapshots:
     dependencies:
       escape-string-regexp: 2.0.0
 
+  stackback@0.0.2: {}
+
   stackframe@1.3.4: {}
 
   stacktrace-parser@0.1.11:
@@ -8633,6 +10050,8 @@ snapshots:
 
   statuses@2.0.2: {}
 
+  std-env@3.10.0: {}
+
   stop-iteration-iterator@1.1.0:
     dependencies:
       es-errors: 1.3.0
@@ -8640,6 +10059,12 @@ snapshots:
 
   stream-buffers@2.2.0: {}
 
+  stream-chain@2.2.5: {}
+
+  stream-json@1.9.1:
+    dependencies:
+      stream-chain: 2.2.5
+
   string-width@4.2.3:
     dependencies:
       emoji-regex: 8.0.0
@@ -8710,6 +10135,10 @@ snapshots:
 
   strip-json-comments@3.1.1: {}
 
+  strip-literal@3.1.0:
+    dependencies:
+      js-tokens: 9.0.1
+
   structured-headers@0.4.1: {}
 
   styled-jsx@5.1.6(@babel/core@7.29.0)(react@19.2.4):
@@ -8731,6 +10160,8 @@ snapshots:
       tinyglobby: 0.2.15
       ts-interface-checker: 0.1.13
 
+  superstruct@2.0.2: {}
+
   supports-color@5.5.0:
     dependencies:
       has-flag: 3.0.0
@@ -8782,6 +10213,8 @@ snapshots:
       glob: 7.2.3
       minimatch: 3.1.2
 
+  text-encoding-utf-8@1.0.2: {}
+
   thenify-all@1.6.0:
     dependencies:
       thenify: 3.3.1
@@ -8792,11 +10225,21 @@ snapshots:
 
   throat@5.0.0: {}
 
+  tinybench@2.9.0: {}
+
+  tinyexec@0.3.2: {}
+
   tinyglobby@0.2.15:
     dependencies:
       fdir: 6.5.0(picomatch@4.0.3)
       picomatch: 4.0.3
 
+  tinypool@1.1.1: {}
+
+  tinyrainbow@2.0.0: {}
+
+  tinyspy@4.0.4: {}
+
   tmpl@1.0.5: {}
 
   to-regex-range@5.0.1:
@@ -8942,14 +10385,99 @@ snapshots:
     dependencies:
       punycode: 2.3.1
 
+  utf-8-validate@5.0.10:
+    dependencies:
+      node-gyp-build: 4.8.4
+    optional: true
+
   utils-merge@1.0.1: {}
 
   uuid@7.0.3: {}
 
+  uuid@8.3.2: {}
+
   validate-npm-package-name@5.0.1: {}
 
   vary@1.1.2: {}
 
+  vite-node@3.2.4(@types/node@20.19.33)(jiti@2.6.1)(lightningcss@1.31.1)(terser@5.46.0)(yaml@2.8.2):
+    dependencies:
+      cac: 6.7.14
+      debug: 4.4.3
+      es-module-lexer: 1.7.0
+      pathe: 2.0.3
+      vite: 7.3.1(@types/node@20.19.33)(jiti@2.6.1)(lightningcss@1.31.1)(terser@5.46.0)(yaml@2.8.2)
+    transitivePeerDependencies:
+      - '@types/node'
+      - jiti
+      - less
+      - lightningcss
+      - sass
+      - sass-embedded
+      - stylus
+      - sugarss
+      - supports-color
+      - terser
+      - tsx
+      - yaml
+
+  vite@7.3.1(@types/node@20.19.33)(jiti@2.6.1)(lightningcss@1.31.1)(terser@5.46.0)(yaml@2.8.2):
+    dependencies:
+      esbuild: 0.27.3
+      fdir: 6.5.0(picomatch@4.0.3)
+      picomatch: 4.0.3
+      postcss: 8.5.6
+      rollup: 4.58.0
+      tinyglobby: 0.2.15
+    optionalDependencies:
+      '@types/node': 20.19.33
+      fsevents: 2.3.3
+      jiti: 2.6.1
+      lightningcss: 1.31.1
+      terser: 5.46.0
+      yaml: 2.8.2
+
+  vitest@3.2.4(@types/node@20.19.33)(jiti@2.6.1)(lightningcss@1.31.1)(terser@5.46.0)(yaml@2.8.2):
+    dependencies:
+      '@types/chai': 5.2.3
+      '@vitest/expect': 3.2.4
+      '@vitest/mocker': 3.2.4(vite@7.3.1(@types/node@20.19.33)(jiti@2.6.1)(lightningcss@1.31.1)(terser@5.46.0)(yaml@2.8.2))
+      '@vitest/pretty-format': 3.2.4
+      '@vitest/runner': 3.2.4
+      '@vitest/snapshot': 3.2.4
+      '@vitest/spy': 3.2.4
+      '@vitest/utils': 3.2.4
+      chai: 5.3.3
+      debug: 4.4.3
+      expect-type: 1.3.0
+      magic-string: 0.30.21
+      pathe: 2.0.3
+      picomatch: 4.0.3
+      std-env: 3.10.0
+      tinybench: 2.9.0
+      tinyexec: 0.3.2
+      tinyglobby: 0.2.15
+      tinypool: 1.1.1
+      tinyrainbow: 2.0.0
+      vite: 7.3.1(@types/node@20.19.33)(jiti@2.6.1)(lightningcss@1.31.1)(terser@5.46.0)(yaml@2.8.2)
+      vite-node: 3.2.4(@types/node@20.19.33)(jiti@2.6.1)(lightningcss@1.31.1)(terser@5.46.0)(yaml@2.8.2)
+      why-is-node-running: 2.3.0
+    optionalDependencies:
+      '@types/node': 20.19.33
+    transitivePeerDependencies:
+      - jiti
+      - less
+      - lightningcss
+      - msw
+      - sass
+      - sass-embedded
+      - stylus
+      - sugarss
+      - supports-color
+      - terser
+      - tsx
+      - yaml
+
   vlq@1.0.1: {}
 
   walker@1.0.8:
@@ -9022,6 +10550,11 @@ snapshots:
     dependencies:
       isexe: 2.0.0
 
+  why-is-node-running@2.3.0:
+    dependencies:
+      siginfo: 2.0.0
+      stackback: 0.0.2
+
   wonka@6.3.5: {}
 
   word-wrap@1.2.5: {}
@@ -9039,13 +10572,22 @@ snapshots:
       imurmurhash: 0.1.4
       signal-exit: 3.0.7
 
-  ws@6.2.3:
+  ws@6.2.3(bufferutil@4.1.0)(utf-8-validate@5.0.10):
     dependencies:
       async-limiter: 1.0.1
+    optionalDependencies:
+      bufferutil: 4.1.0
+      utf-8-validate: 5.0.10
 
-  ws@7.5.10: {}
+  ws@7.5.10(bufferutil@4.1.0)(utf-8-validate@5.0.10):
+    optionalDependencies:
+      bufferutil: 4.1.0
+      utf-8-validate: 5.0.10
 
-  ws@8.19.0: {}
+  ws@8.19.0(bufferutil@4.1.0)(utf-8-validate@5.0.10):
+    optionalDependencies:
+      bufferutil: 4.1.0
+      utf-8-validate: 5.0.10
 
   xcode@3.0.1:
     dependencies:
diff --git a/scripts/check-core-boundaries.mjs b/scripts/check-core-boundaries.mjs
new file mode 100644
index 0000000..cc19beb
--- /dev/null
+++ b/scripts/check-core-boundaries.mjs
@@ -0,0 +1,52 @@
+import fs from 'node:fs';
+import path from 'node:path';
+
+const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
+const CORE_SRC = path.join(ROOT, 'packages/core/src');
+const CORE_PKG = path.join(ROOT, 'packages/core/package.json');
+
+const forbidden = [
+  '@solana/web3.js',
+  '@solana/',
+  '@orca-so/',
+  '@raydium-io/',
+  '@kamino-finance/',
+  '@clmm-autopilot/solana',
+  'packages/solana',
+];
+
+function collectTsFiles(dir) {
+  const out = [];
+  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
+    const p = path.join(dir, entry.name);
+    if (entry.isDirectory()) out.push(...collectTsFiles(p));
+    else if (entry.isFile() && /\.(ts|tsx|mts|cts)$/.test(entry.name)) out.push(p);
+  }
+  return out;
+}
+
+let violations = [];
+for (const file of collectTsFiles(CORE_SRC)) {
+  const txt = fs.readFileSync(file, 'utf8');
+  for (const token of forbidden) {
+    if (txt.includes(token)) violations.push(`${path.relative(ROOT, file)} contains forbidden token: ${token}`);
+  }
+}
+
+const pkg = JSON.parse(fs.readFileSync(CORE_PKG, 'utf8'));
+const depFields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
+for (const field of depFields) {
+  const deps = pkg[field] || {};
+  for (const name of Object.keys(deps)) {
+    if (name.includes('solana') || name.includes('orca') || name.includes('raydium') || name === '@clmm-autopilot/solana') {
+      violations.push(`packages/core/package.json has forbidden ${field} entry: ${name}`);
+    }
+  }
+}
+
+if (violations.length) {
+  console.error('Boundary check failed:\n' + violations.map(v => `- ${v}`).join('\n'));
+  process.exit(1);
+}
+
+console.log('Boundary check passed for packages/core');
diff --git a/specs/m1-foundations.spec.md b/specs/m1-foundations.spec.md
index 8f86259..9519fd8 100644
--- a/specs/m1-foundations.spec.md
+++ b/specs/m1-foundations.spec.md
@@ -53,7 +53,7 @@ Additional dependency direction rule:
   - `docs/runbooks/mobile-mwa.md` with exact commands to run on Android emulator/device
 - Root scripts:
   - `pnpm -r test` runs core tests
-  - `pnpm --filter mobile <smoke>` runs without secrets in dev mode (CI can skip interactive signing)
+  - `pnpm --filter @clmm-autopilot/mobile smoke:mwa` runs mobile smoke in dev mode (CI can skip interactive signing)
 
 ## Acceptance criteria (pass/fail)
 
```
