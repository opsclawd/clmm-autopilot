# Review Pack

## Branch / Base
- HEAD: m16-token2022-first-class @ 2f151e5
- Base: origin/main @ 7ed64f4
- Merge-base: 7ed64f4047051c56704ecf8871eb3b2a0226b4d1 @ 7ed64f4

## Recent commits
2f151e5 (HEAD -> m16-token2022-first-class) m16: token20222 first class

## Diff stat
 docs/runbook.md                                    |   1 +
 docs/spec-traceability.md                          |   1 +
 packages/solana/src/__tests__/e2eDevnet.spec.ts    |  25 +++
 .../src/__tests__/executeOnce-underfunded.spec.ts  |  39 +++--
 packages/solana/src/__tests__/executeOnce.spec.ts  |  19 ++-
 .../solana/src/__tests__/executionBuilder.spec.ts  |   3 +-
 .../solana/src/__tests__/orcaExitBuilder.spec.ts   |  69 ++++++++
 .../solana/src/__tests__/orcaInspector.spec.ts     |  36 +++++
 .../solana/src/__tests__/orcaSwapAdapter.spec.ts   |  58 ++++++-
 packages/solana/src/__tests__/reliability.spec.ts  |  17 ++
 packages/solana/src/__tests__/requirements.spec.ts | 149 +++++++++++------
 .../src/__tests__/tokenProgramResolver.spec.ts     |  88 +++++++++++
 .../solana/src/__tests__/whirlpoolVariant.spec.ts  |  56 +++++++
 packages/solana/src/ata.ts                         |  40 +++--
 packages/solana/src/e2eDevnet.ts                   |  57 +++++++
 packages/solana/src/errors.ts                      |   1 +
 packages/solana/src/executionBuilder.ts            |  34 +---
 packages/solana/src/index.ts                       |   3 +
 packages/solana/src/orcaExitBuilder.ts             | 176 ++++++++++++++-------
 packages/solana/src/orcaInspector.ts               |  15 +-
 packages/solana/src/requirements.ts                |  50 ++++--
 .../src/swap/orca/OrcaWhirlpoolSwapAdapter.ts      |  70 +++++---
 packages/solana/src/token/constants.ts             |  11 ++
 packages/solana/src/token/program.ts               |  85 ++++++++++
 packages/solana/src/token/whirlpool.ts             |  39 +++++
 packages/solana/src/types.ts                       |   1 +
 packages/solana/src/wsol.ts                        |   9 +-
 specs/m16-token2022-first-class.spec.md            | 144 +++++++++++++++++
 28 files changed, 1069 insertions(+), 227 deletions(-)

## Full PR diff
```diff
diff --git a/docs/runbook.md b/docs/runbook.md
index c6b215d..68c0452 100644
--- a/docs/runbook.md
+++ b/docs/runbook.md
@@ -24,6 +24,7 @@ Harness env vars:
 - `SWAP_ROUTER` (optional: `noop` | `orca` | `jupiter`, default `noop` for deterministic harness runs)
 - `FORCE_DECISION` (optional: `TRIGGER_DOWN` | `TRIGGER_UP`; overrides live policy decision to force receipt proof path)
 - `REQUIRE_RECEIPT_PROOF` (optional: `1|0|true|false`, default `0`; when enabled, `HOLD` is treated as failure)
+- `TOKEN2022_POSITION_ADDRESS` (optional; non-blocking check: when set, harness logs whether that position resolves to a Token-2022 pool and never fails the main run if unavailable/mismatched)
 - `RECEIPT_IDENTITY_SOURCE` (optional, advanced: set to `config` to force legacy config fallback identity instead of devnet manifest)
 
 Example:
diff --git a/docs/spec-traceability.md b/docs/spec-traceability.md
index ddabed0..7df7f00 100644
--- a/docs/spec-traceability.md
+++ b/docs/spec-traceability.md
@@ -18,3 +18,4 @@
 | M13 orca decode stabilization | met | Runtime decode path uses centralized `orca/decode.ts` with fixtures and explicit `ORCA_DECODE_FAILED` normalization. |
 | M14 swap adapters | met | Core swap adapter contract/types + router-aware attestation fields + explicit adapter implementations/registry in solana; execute path and devnet harness now route through configured adapter with cluster gating (`SWAP_ROUTER_UNSUPPORTED_CLUSTER`). |
 | M15 devnet receipt deploy | met | Deploy-derived manifest + deterministic IDL hash gate + consistency guard + manual devnet workflow updates are in place. |
+| M16 token2022 first-class | met | Token-program resolver + LRU cache + terminal unsupported owner errors are wired; requirements owns ATA existence planning via `missingAtas`; builder consumes plan-only ATA creation; Whirlpool remove/collect/swap share v1/v2 selector with unconditional memo on v2; matrix-focused tests were added. |
diff --git a/packages/solana/src/__tests__/e2eDevnet.spec.ts b/packages/solana/src/__tests__/e2eDevnet.spec.ts
index 94ac407..44efd0a 100644
--- a/packages/solana/src/__tests__/e2eDevnet.spec.ts
+++ b/packages/solana/src/__tests__/e2eDevnet.spec.ts
@@ -195,6 +195,31 @@ describe('runDevnetE2E refusals', () => {
     await cleanup();
   });
 
+  it('treats optional token2022 scenario as non-blocking on HOLD', async () => {
+    const { env, cleanup } = await makeEnv();
+    env.TOKEN2022_POSITION_ADDRESS = 'not-a-pubkey';
+    const logs: Array<Record<string, unknown>> = [];
+
+    await expect(
+      runDevnetE2E(
+        env,
+        (entry) => logs.push(entry),
+        harnessDeps({
+          loadPositionSnapshot: vi.fn(async () => mockSnapshot(env.POSITION_ADDRESS, {
+            currentTickIndex: 0,
+            lowerTickIndex: -10,
+            upperTickIndex: 10,
+            inRange: true,
+          })) as any,
+        }),
+      ),
+    ).resolves.toBeUndefined();
+
+    expect(logs.some((entry) => entry.step === 'token2022.optional.skip')).toBe(true);
+    expect(logs.some((entry) => entry.step === 'harness.complete' && entry.status === 'HOLD')).toBe(true);
+    await cleanup();
+  });
+
   it('forwards FORCE_DECISION into executeOnce when live policy would otherwise HOLD', async () => {
     const { env, cleanup } = await makeEnv();
     env.FORCE_DECISION = 'TRIGGER_DOWN';
diff --git a/packages/solana/src/__tests__/executeOnce-underfunded.spec.ts b/packages/solana/src/__tests__/executeOnce-underfunded.spec.ts
index ce62da1..7c377ed 100644
--- a/packages/solana/src/__tests__/executeOnce-underfunded.spec.ts
+++ b/packages/solana/src/__tests__/executeOnce-underfunded.spec.ts
@@ -1,20 +1,36 @@
 import { describe, expect, it, vi } from 'vitest';
 import { DEFAULT_CONFIG, encodeAttestationPayload } from '@clmm-autopilot/core';
 import { PublicKey } from '@solana/web3.js';
+import { TOKEN_PROGRAM_ID } from '../token/constants';
 
 const RECEIPT_PROGRAM_ID = new PublicKey(DEFAULT_CONFIG.receiptProgramId!);
 const BPF_UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
+const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
+const USDC_MINT = new PublicKey('BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k');
+const POSITION_MINT = new PublicKey(new Uint8Array(32).fill(12));
 
 function getAccountInfoForProgramOnly(programId = RECEIPT_PROGRAM_ID) {
   return vi.fn(async (pubkey: PublicKey) => {
-    if (!pubkey.equals(programId)) return null;
-    return {
-      executable: true,
-      owner: BPF_UPGRADEABLE_LOADER,
-      lamports: 1,
-      data: Buffer.alloc(0),
-      rentEpoch: 0,
-    };
+    if (pubkey.equals(programId)) {
+      return {
+        executable: true,
+        owner: BPF_UPGRADEABLE_LOADER,
+        lamports: 1,
+        data: Buffer.alloc(0),
+        rentEpoch: 0,
+      };
+    }
+    if (pubkey.equals(SOL_MINT) || pubkey.equals(USDC_MINT) || pubkey.equals(POSITION_MINT)) {
+      return {
+        executable: false,
+        owner: TOKEN_PROGRAM_ID,
+        lamports: 1,
+        data: Buffer.alloc(82),
+        rentEpoch: 0,
+      };
+    }
+    // ATA existence checks intentionally return null to force rent requirements for underfunded path.
+    return null;
   });
 }
 
@@ -47,6 +63,7 @@ vi.mock('../orcaInspector', async () => {
   const { PublicKey } = await import('@solana/web3.js');
   const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
   const USDC_MINT = new PublicKey('BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k');
+  const { TOKEN_PROGRAM_ID } = await import('../token/constants');
   return {
     loadPositionSnapshot: async () => ({
       cluster: 'devnet',
@@ -54,7 +71,7 @@ vi.mock('../orcaInspector', async () => {
       pairValid: true,
       whirlpool: new PublicKey(new Uint8Array(32).fill(10)),
       position: new PublicKey(new Uint8Array(32).fill(11)),
-      positionMint: new PublicKey(new Uint8Array(32).fill(12)),
+      positionMint: POSITION_MINT,
       currentTickIndex: 100,
       lowerTickIndex: 50,
       upperTickIndex: 150,
@@ -69,8 +86,8 @@ vi.mock('../orcaInspector', async () => {
       tokenVaultB: new PublicKey(new Uint8Array(32).fill(14)),
       tickArrayLower: new PublicKey(new Uint8Array(32).fill(15)),
       tickArrayUpper: new PublicKey(new Uint8Array(32).fill(16)),
-      tokenProgramA: new PublicKey(new Uint8Array(32).fill(17)),
-      tokenProgramB: new PublicKey(new Uint8Array(32).fill(18)),
+      tokenProgramA: TOKEN_PROGRAM_ID,
+      tokenProgramB: TOKEN_PROGRAM_ID,
       removePreview: { tokenAOut: BigInt(1), tokenBOut: BigInt(1) },
       removePreviewReasonCode: null,
     }),
diff --git a/packages/solana/src/__tests__/executeOnce.spec.ts b/packages/solana/src/__tests__/executeOnce.spec.ts
index 8406599..d8d283c 100644
--- a/packages/solana/src/__tests__/executeOnce.spec.ts
+++ b/packages/solana/src/__tests__/executeOnce.spec.ts
@@ -2,6 +2,7 @@ import { beforeEach, describe, expect, it, vi } from 'vitest';
 import { DEFAULT_CONFIG } from '@clmm-autopilot/core';
 import { PublicKey, VersionedTransaction } from '@solana/web3.js';
 import { deriveReceiptPda } from '../receipt';
+import { TOKEN_PROGRAM_ID } from '../token/constants';
 
 const DEVNET_USDC_MINT = 'BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k';
 const RECEIPT_PROGRAM_ID = new PublicKey(DEFAULT_CONFIG.receiptProgramId!);
@@ -9,12 +10,22 @@ const BPF_UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111
 
 function getAccountInfoForProgramOnly(programId = RECEIPT_PROGRAM_ID) {
   return vi.fn(async (pubkey: PublicKey) => {
-    if (!pubkey.equals(programId)) return null;
+    if (pubkey.equals(programId)) {
+      return {
+        executable: true,
+        owner: BPF_UPGRADEABLE_LOADER,
+        lamports: 1,
+        data: Buffer.alloc(0),
+        rentEpoch: 0,
+      };
+    }
+    // Requirements/token-program resolution path probes arbitrary mints + ATA addresses.
+    // Return a generic token-owned account by default so tests can focus on executeOnce behavior.
     return {
-      executable: true,
-      owner: BPF_UPGRADEABLE_LOADER,
+      executable: false,
+      owner: TOKEN_PROGRAM_ID,
       lamports: 1,
-      data: Buffer.alloc(0),
+      data: Buffer.alloc(82),
       rentEpoch: 0,
     };
   });
diff --git a/packages/solana/src/__tests__/executionBuilder.spec.ts b/packages/solana/src/__tests__/executionBuilder.spec.ts
index 476feb7..66b2c22 100644
--- a/packages/solana/src/__tests__/executionBuilder.spec.ts
+++ b/packages/solana/src/__tests__/executionBuilder.spec.ts
@@ -82,6 +82,7 @@ function buildConfig(overrides?: Partial<BuildExitConfig>): BuildExitConfig {
     requirements: {
       rentLamports: 2_039_280,
       ataCount: 1,
+      missingAtas: [{ ata: pk(210), mint: pk(211), owner: authority, tokenProgramId: pk(212) }],
       txFeeLamports: 20_000,
       priorityFeeLamports: 5_000,
       bufferLamports: 10_000,
@@ -91,7 +92,7 @@ function buildConfig(overrides?: Partial<BuildExitConfig>): BuildExitConfig {
     attestationPayloadBytes: new Uint8Array(240),
     simulate: async (): Promise<SimResult> => ({ err: null, logs: ['ok'] }),
     buildOrcaExitIxs: () => ({
-      conditionalAtaIxs: [ix(21), ix(22)],
+      variant: 'v2',
       removeLiquidityIx: ix(31),
       collectFeesIx: ix(32),
       tokenOwnerAccountA: pk(1),
diff --git a/packages/solana/src/__tests__/orcaExitBuilder.spec.ts b/packages/solana/src/__tests__/orcaExitBuilder.spec.ts
new file mode 100644
index 0000000..3864070
--- /dev/null
+++ b/packages/solana/src/__tests__/orcaExitBuilder.spec.ts
@@ -0,0 +1,69 @@
+import { describe, expect, it } from 'vitest';
+import { PublicKey } from '@solana/web3.js';
+import { buildOrcaExitIxs } from '../orcaExitBuilder';
+import { MEMO_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../token/constants';
+
+const pk = (seed: number) => new PublicKey(new Uint8Array(32).fill(seed));
+const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
+const USDC_MINT = new PublicKey('BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k');
+
+function buildSnapshot(overrides: Partial<Parameters<typeof buildOrcaExitIxs>[0]['snapshot']> = {}) {
+  return {
+    cluster: 'devnet' as const,
+    pairLabel: 'SOL/USDC',
+    pairValid: true,
+    whirlpool: pk(1),
+    position: pk(2),
+    positionMint: pk(3),
+    positionTokenProgram: TOKEN_PROGRAM_ID,
+    currentTickIndex: 100,
+    lowerTickIndex: 50,
+    upperTickIndex: 150,
+    tickSpacing: 1,
+    inRange: true,
+    liquidity: 10n,
+    tokenMintA: SOL_MINT,
+    tokenMintB: USDC_MINT,
+    tokenDecimalsA: 9,
+    tokenDecimalsB: 6,
+    tokenVaultA: pk(4),
+    tokenVaultB: pk(5),
+    tickArrayLower: pk(6),
+    tickArrayUpper: pk(7),
+    tokenProgramA: TOKEN_PROGRAM_ID,
+    tokenProgramB: TOKEN_PROGRAM_ID,
+    removePreview: null,
+    removePreviewReasonCode: null,
+    ...overrides,
+  };
+}
+
+describe('buildOrcaExitIxs', () => {
+  it('uses v1 remove/collect without memo when both sides are token-v1', () => {
+    const out = buildOrcaExitIxs({
+      snapshot: buildSnapshot(),
+      authority: pk(8),
+      payer: pk(9),
+    });
+
+    expect(out.variant).toBe('v1');
+    expect(Array.from(out.removeLiquidityIx.data.subarray(0, 8))).toEqual([160, 38, 208, 111, 104, 91, 44, 1]);
+    expect(Array.from(out.collectFeesIx.data.subarray(0, 8))).toEqual([164, 152, 207, 99, 30, 186, 19, 182]);
+    expect(out.removeLiquidityIx.keys.some((key) => key.pubkey.equals(MEMO_PROGRAM_ID))).toBe(false);
+    expect(out.collectFeesIx.keys.some((key) => key.pubkey.equals(MEMO_PROGRAM_ID))).toBe(false);
+  });
+
+  it('uses v2 remove/collect with unconditional memo when token-2022 is involved', () => {
+    const out = buildOrcaExitIxs({
+      snapshot: buildSnapshot({ tokenProgramB: TOKEN_2022_PROGRAM_ID }),
+      authority: pk(8),
+      payer: pk(9),
+    });
+
+    expect(out.variant).toBe('v2');
+    expect(Array.from(out.removeLiquidityIx.data.subarray(0, 8))).toEqual([58, 127, 188, 62, 79, 82, 196, 96]);
+    expect(Array.from(out.collectFeesIx.data.subarray(0, 8))).toEqual([207, 117, 95, 191, 229, 180, 226, 15]);
+    expect(out.removeLiquidityIx.keys.some((key) => key.pubkey.equals(MEMO_PROGRAM_ID))).toBe(true);
+    expect(out.collectFeesIx.keys.some((key) => key.pubkey.equals(MEMO_PROGRAM_ID))).toBe(true);
+  });
+});
diff --git a/packages/solana/src/__tests__/orcaInspector.spec.ts b/packages/solana/src/__tests__/orcaInspector.spec.ts
index 7a70e84..6b700f6 100644
--- a/packages/solana/src/__tests__/orcaInspector.spec.ts
+++ b/packages/solana/src/__tests__/orcaInspector.spec.ts
@@ -411,6 +411,42 @@ describe('loadPositionSnapshot', () => {
     });
   });
 
+  it('returns UNSUPPORTED_MINT_OWNER when mint owner is not token/token-2022', async () => {
+    clearTickArrayCache();
+    const position = Keypair.generate().publicKey;
+    const whirlpool = Keypair.generate().publicKey;
+    const positionMint = Keypair.generate().publicKey;
+    const tokenMintA = SOL_MINT;
+    const tokenMintB = USDC_MINT;
+
+    const accounts = new Map<string, { data: Buffer; owner?: PublicKey }>();
+    accounts.set(
+      position.toBase58(),
+      { data: mkPositionData({ whirlpool, positionMint, liquidity: 1n, lowerTickIndex: 120, upperTickIndex: 200 }) },
+    );
+    accounts.set(
+      whirlpool.toBase58(),
+      {
+        data: mkWhirlpoolData({
+          tickSpacing: 1,
+          currentTickIndex: 150,
+          tokenMintA,
+          tokenVaultA: Keypair.generate().publicKey,
+          tokenMintB,
+          tokenVaultB: Keypair.generate().publicKey,
+        }),
+      },
+    );
+    accounts.set(positionMint.toBase58(), { data: mkMintData(0), owner: TOKEN_PROGRAM_V1 });
+    accounts.set(tokenMintA.toBase58(), { data: mkMintData(6), owner: TOKEN_PROGRAM_V1 });
+    accounts.set(tokenMintB.toBase58(), { data: mkMintData(9), owner: Keypair.generate().publicKey });
+
+    await expect(loadPositionSnapshot(mockConn({ accounts }), position)).rejects.toMatchObject({
+      code: 'UNSUPPORTED_MINT_OWNER',
+      retryable: false,
+    });
+  });
+
   it('propagates ORCA_DECODE_FAILED when decoder fails', async () => {
     clearTickArrayCache();
     const position = Keypair.generate().publicKey;
diff --git a/packages/solana/src/__tests__/orcaSwapAdapter.spec.ts b/packages/solana/src/__tests__/orcaSwapAdapter.spec.ts
index 6deb90a..5e03471 100644
--- a/packages/solana/src/__tests__/orcaSwapAdapter.spec.ts
+++ b/packages/solana/src/__tests__/orcaSwapAdapter.spec.ts
@@ -1,6 +1,7 @@
 import { describe, expect, it, vi } from 'vitest';
 import BN from 'bn.js';
 import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
+import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../token/constants';
 
 vi.mock('@orca-so/whirlpools-sdk', () => ({
   UseFallbackTickArray: { Never: 'Never' },
@@ -25,6 +26,11 @@ vi.mock('@orca-so/whirlpools-sdk', () => ({
     supplementalTickArrays: [],
   })),
   WhirlpoolIx: {
+    swapIx: vi.fn(() => ({
+      instructions: [{ programId: new PublicKey(new Uint8Array(32).fill(31)) } as unknown as TransactionInstruction],
+      cleanupInstructions: [],
+      signers: [],
+    })),
     swapV2Ix: vi.fn(() => ({
       instructions: [{ programId: new PublicKey(new Uint8Array(32).fill(30)) } as unknown as TransactionInstruction],
       cleanupInstructions: [],
@@ -71,7 +77,52 @@ describe('OrcaWhirlpoolSwapAdapter', () => {
     expect(quote.debug?.orcaQuote).toBeDefined();
   });
 
-  it('builds swap instruction from quote debug metadata', async () => {
+  it('builds v1 swap instruction when both token programs are token-v1', async () => {
+    const adapter = new OrcaWhirlpoolSwapAdapter();
+    const quote = {
+      router: 'orca' as const,
+      inMint: pk(1).toBase58(),
+      outMint: pk(2).toBase58(),
+      swapInAmount: 1000n,
+      swapMinOutAmount: 900n,
+      slippageBpsCap: 50,
+      quotedAtUnixSec: 1700000000,
+      debug: {
+        orcaQuote: {
+          amount: '1000',
+          otherAmountThreshold: '900',
+          sqrtPriceLimit: '1',
+          amountSpecifiedIsInput: true,
+          aToB: true,
+          tickArray0: pk(21).toBase58(),
+          tickArray1: pk(22).toBase58(),
+          tickArray2: pk(23).toBase58(),
+          supplementalTickArrays: [],
+        },
+      },
+    };
+
+    const result = await adapter.buildSwapIxs(quote, pk(10), {
+      connection: {} as any,
+      whirlpool: pk(3),
+      tickSpacing: 1,
+      tickCurrentIndex: 0,
+      tickArrays: [pk(21), pk(22), pk(23)],
+      tokenMintA: pk(4),
+      tokenMintB: pk(5),
+      tokenVaultA: pk(6),
+      tokenVaultB: pk(7),
+      tokenProgramA: TOKEN_PROGRAM_ID,
+      tokenProgramB: TOKEN_PROGRAM_ID,
+      aToB: true,
+    });
+
+    expect(result.instructions.length).toBeGreaterThan(0);
+    expect(result.instructions[0].programId.toBase58()).toBe(pk(31).toBase58());
+    expect(result.lookupTableAddresses).toEqual([]);
+  });
+
+  it('builds v2 swap instruction when either token program is token-2022', async () => {
     const adapter = new OrcaWhirlpoolSwapAdapter();
     const quote = {
       router: 'orca' as const,
@@ -106,12 +157,13 @@ describe('OrcaWhirlpoolSwapAdapter', () => {
       tokenMintB: pk(5),
       tokenVaultA: pk(6),
       tokenVaultB: pk(7),
-      tokenProgramA: pk(8),
-      tokenProgramB: pk(9),
+      tokenProgramA: TOKEN_PROGRAM_ID,
+      tokenProgramB: TOKEN_2022_PROGRAM_ID,
       aToB: true,
     });
 
     expect(result.instructions.length).toBeGreaterThan(0);
+    expect(result.instructions[0].programId.toBase58()).toBe(pk(30).toBase58());
     expect(result.lookupTableAddresses).toEqual([]);
   });
 });
diff --git a/packages/solana/src/__tests__/reliability.spec.ts b/packages/solana/src/__tests__/reliability.spec.ts
index fa54972..a5910cc 100644
--- a/packages/solana/src/__tests__/reliability.spec.ts
+++ b/packages/solana/src/__tests__/reliability.spec.ts
@@ -64,4 +64,21 @@ describe('reliability', () => {
     expect(sleep).toHaveBeenNthCalledWith(1, 250);
     expect(sleep).toHaveBeenNthCalledWith(2, 750);
   });
+
+  it('does not retry terminal unsupported mint owner errors', async () => {
+    const fn = vi.fn(async () => {
+      const err = new Error('unsupported') as Error & { code: 'UNSUPPORTED_MINT_OWNER'; retryable: false };
+      err.code = 'UNSUPPORTED_MINT_OWNER';
+      err.retryable = false;
+      throw err;
+    });
+    const sleep = vi.fn(async () => {});
+
+    await expect(withBoundedRetry(fn, sleep, DEFAULT_CONFIG.execution)).rejects.toMatchObject({
+      code: 'UNSUPPORTED_MINT_OWNER',
+      retryable: false,
+    });
+    expect(fn).toHaveBeenCalledTimes(1);
+    expect(sleep).not.toHaveBeenCalled();
+  });
 });
diff --git a/packages/solana/src/__tests__/requirements.spec.ts b/packages/solana/src/__tests__/requirements.spec.ts
index dd17d3c..4c118be 100644
--- a/packages/solana/src/__tests__/requirements.spec.ts
+++ b/packages/solana/src/__tests__/requirements.spec.ts
@@ -1,36 +1,63 @@
 import { describe, expect, it, vi } from 'vitest';
 import { PublicKey } from '@solana/web3.js';
-import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
 import { computeExecutionRequirements } from '../requirements';
 import { getAta } from '../ata';
+import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../token/constants';
 
 const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
 const USDC_MINT = new PublicKey('BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k');
 
 const pk = (seed: number) => new PublicKey(new Uint8Array(32).fill(seed));
 
-const baseSnapshot = {
-  positionMint: pk(111),
-  tokenMintA: SOL_MINT,
-  tokenMintB: USDC_MINT,
-  tokenProgramA: TOKEN_PROGRAM_ID,
-  tokenProgramB: TOKEN_PROGRAM_ID,
-};
+function mockConnection(args: {
+  existingAtas: Set<string>;
+  mintOwners?: Map<string, PublicKey>;
+  tokenAccountRent?: number;
+}) {
+  return {
+    getAccountInfo: vi.fn(async (pubkey: PublicKey) => {
+      const key = pubkey.toBase58();
+      const mintOwner = args.mintOwners?.get(key);
+      if (mintOwner) return { owner: mintOwner, data: Buffer.alloc(82) } as any;
+      return args.existingAtas.has(key) ? (({} as unknown) as any) : null;
+    }),
+    getMinimumBalanceForRentExemption: vi.fn(async () => args.tokenAccountRent ?? 1_000),
+  };
+}
 
 describe('computeExecutionRequirements', () => {
-  it('counts no missing ATAs when all exist (including WSOL when SOL involved)', async () => {
-    const connection = {
-      getAccountInfo: vi.fn(async () => ({}) as any),
-      getMinimumBalanceForRentExemption: vi.fn(async () => 2_039_280),
+  it('counts no missing ATAs when all required accounts exist', async () => {
+    const authority = pk(1);
+    const snapshot = {
+      positionMint: pk(111),
+      positionTokenProgram: TOKEN_PROGRAM_ID,
+      tokenMintA: SOL_MINT,
+      tokenMintB: USDC_MINT,
+      tokenProgramA: TOKEN_PROGRAM_ID,
+      tokenProgramB: TOKEN_PROGRAM_ID,
     };
 
+    const existingAtas = new Set<string>([
+      getAta(snapshot.positionMint, authority, snapshot.positionTokenProgram).toBase58(),
+      getAta(snapshot.tokenMintA, authority, snapshot.tokenProgramA).toBase58(),
+      getAta(snapshot.tokenMintB, authority, snapshot.tokenProgramB).toBase58(),
+    ]);
+
     const res = await computeExecutionRequirements({
-      connection,
-      snapshot: baseSnapshot,
+      connection: mockConnection({
+        existingAtas,
+        mintOwners: new Map<string, PublicKey>([
+          [snapshot.positionMint.toBase58(), TOKEN_PROGRAM_ID],
+          [snapshot.tokenMintA.toBase58(), TOKEN_PROGRAM_ID],
+          [snapshot.tokenMintB.toBase58(), TOKEN_PROGRAM_ID],
+        ]),
+        tokenAccountRent: 2_039_280,
+      }),
+      snapshot,
       quote: { inputMint: SOL_MINT, outputMint: USDC_MINT },
       swapPlanned: true,
-      authority: pk(1),
-      payer: pk(1),
+      authority,
+      payer: authority,
       txFeeLamports: 20_000,
       computeUnitLimit: 600_000,
       computeUnitPriceMicroLamports: 10_000,
@@ -38,34 +65,40 @@ describe('computeExecutionRequirements', () => {
     });
 
     expect(res.ataCount).toBe(0);
+    expect(res.missingAtas).toEqual([]);
     expect(res.rentLamports).toBe(0);
     expect(res.priorityFeeLamports).toBe(Math.ceil((600_000 * 10_000) / 1_000_000));
     expect(res.totalRequiredLamports).toBe(res.txFeeLamports + res.priorityFeeLamports + res.bufferLamports);
   });
 
-  it('counts missing input/output ATAs when swap uses SPL->SPL and both are absent', async () => {
-    const missing = new Set<string>();
+  it('resolves quote mint token programs and emits missingAtas once', async () => {
     const authority = pk(9);
-
-    // Make only the Orca-required *position ATA* exist; anything else missing.
-    const existing = new Set<string>([getAta(pk(111), authority, TOKEN_PROGRAM_ID).toBase58()]);
-
-    const connection = {
-      getAccountInfo: vi.fn(async (pubkey: PublicKey) => {
-        if (missing.has(pubkey.toBase58())) return null;
-        // Return null by default for this test unless explicitly marked existing.
-        return existing.has(pubkey.toBase58()) ? (({}) as any) : null;
-      }),
-      getMinimumBalanceForRentExemption: vi.fn(async () => 1000),
-    };
-
-    // Force both swap mint ATAs missing by not marking them existing.
+    const positionMint = pk(111);
+    const tokenMintA = pk(55);
+    const tokenMintB = pk(66);
     const inputMint = pk(33);
     const outputMint = pk(44);
+    const snapshot = {
+      positionMint,
+      positionTokenProgram: TOKEN_PROGRAM_ID,
+      tokenMintA,
+      tokenMintB,
+      tokenProgramA: TOKEN_PROGRAM_ID,
+      tokenProgramB: TOKEN_PROGRAM_ID,
+    };
+
+    const existingAtas = new Set<string>([getAta(positionMint, authority, TOKEN_PROGRAM_ID).toBase58()]);
+    const mintOwners = new Map<string, PublicKey>([
+      [positionMint.toBase58(), TOKEN_PROGRAM_ID],
+      [tokenMintA.toBase58(), TOKEN_PROGRAM_ID],
+      [tokenMintB.toBase58(), TOKEN_PROGRAM_ID],
+      [inputMint.toBase58(), TOKEN_2022_PROGRAM_ID],
+      [outputMint.toBase58(), TOKEN_PROGRAM_ID],
+    ]);
 
     const res = await computeExecutionRequirements({
-      connection,
-      snapshot: { ...baseSnapshot, tokenMintA: inputMint, tokenMintB: outputMint },
+      connection: mockConnection({ existingAtas, mintOwners, tokenAccountRent: 1_000 }),
+      snapshot,
       quote: { inputMint, outputMint },
       swapPlanned: true,
       authority,
@@ -76,28 +109,42 @@ describe('computeExecutionRequirements', () => {
       bufferLamports: 0,
     });
 
-    // Required ATAs: positionMint + tokenMintA + tokenMintB + inputMint + outputMint (some overlap possible).
-    // With snapshot tokenMintA/B equal to input/output, the unique set is positionMint + inputMint + outputMint.
-    // We marked only positionMint existing => 2 missing.
-    expect(res.ataCount).toBe(2);
-    expect(res.rentLamports).toBe(2000);
+    expect(res.ataCount).toBe(4);
+    expect(res.rentLamports).toBe(4_000);
+    expect(res.missingAtas).toHaveLength(4);
+    const inputAta = getAta(inputMint, authority, TOKEN_2022_PROGRAM_ID).toBase58();
+    expect(res.missingAtas.find((entry) => entry.ata.toBase58() === inputAta)?.tokenProgramId.toBase58()).toBe(
+      TOKEN_2022_PROGRAM_ID.toBase58(),
+    );
   });
 
-  it('includes WSOL ATA when SOL is output and WSOL ATA is missing', async () => {
+  it('includes WSOL ATA in missingAtas when SOL swap lifecycle is required', async () => {
     const authority = pk(7);
-    const missing = new Set<string>();
-
-    const wsolAta = getAta(SOL_MINT, authority, TOKEN_PROGRAM_ID);
-    missing.add(wsolAta.toBase58());
-
-    const connection = {
-      getAccountInfo: vi.fn(async (pubkey: PublicKey) => (missing.has(pubkey.toBase58()) ? null : (({}) as any))),
-      getMinimumBalanceForRentExemption: vi.fn(async () => 500),
+    const snapshot = {
+      positionMint: pk(111),
+      positionTokenProgram: TOKEN_PROGRAM_ID,
+      tokenMintA: SOL_MINT,
+      tokenMintB: USDC_MINT,
+      tokenProgramA: TOKEN_PROGRAM_ID,
+      tokenProgramB: TOKEN_PROGRAM_ID,
     };
+    const wsolAta = getAta(SOL_MINT, authority, TOKEN_PROGRAM_ID).toBase58();
+    const existingAtas = new Set<string>([
+      getAta(snapshot.positionMint, authority, snapshot.positionTokenProgram).toBase58(),
+      getAta(snapshot.tokenMintB, authority, snapshot.tokenProgramB).toBase58(),
+    ]);
 
     const res = await computeExecutionRequirements({
-      connection,
-      snapshot: baseSnapshot,
+      connection: mockConnection({
+        existingAtas,
+        mintOwners: new Map<string, PublicKey>([
+          [snapshot.positionMint.toBase58(), TOKEN_PROGRAM_ID],
+          [snapshot.tokenMintA.toBase58(), TOKEN_PROGRAM_ID],
+          [snapshot.tokenMintB.toBase58(), TOKEN_PROGRAM_ID],
+        ]),
+        tokenAccountRent: 500,
+      }),
+      snapshot,
       quote: { inputMint: USDC_MINT, outputMint: SOL_MINT },
       swapPlanned: true,
       authority,
@@ -111,5 +158,7 @@ describe('computeExecutionRequirements', () => {
     expect(res.ataCount).toBe(1);
     expect(res.rentLamports).toBe(500);
     expect(res.totalRequiredLamports).toBe(500);
+    expect(res.missingAtas).toHaveLength(1);
+    expect(res.missingAtas[0].ata.toBase58()).toBe(wsolAta);
   });
 });
diff --git a/packages/solana/src/__tests__/tokenProgramResolver.spec.ts b/packages/solana/src/__tests__/tokenProgramResolver.spec.ts
new file mode 100644
index 0000000..884d431
--- /dev/null
+++ b/packages/solana/src/__tests__/tokenProgramResolver.spec.ts
@@ -0,0 +1,88 @@
+import { afterEach, describe, expect, it, vi } from 'vitest';
+import { PublicKey } from '@solana/web3.js';
+import {
+  __clearTokenProgramResolverCacheForTests,
+  __tokenProgramResolverCacheSizeForTests,
+  resolveTokenProgramForMint,
+} from '../token/program';
+import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../token/constants';
+
+const pk = (seed: number) => {
+  const bytes = new Uint8Array(32);
+  bytes.fill(seed & 0xff);
+  bytes[0] = seed & 0xff;
+  bytes[1] = (seed >> 8) & 0xff;
+  return new PublicKey(bytes);
+};
+
+function mockConnection(owners: Map<string, PublicKey>) {
+  return {
+    getAccountInfo: vi.fn(async (mint: PublicKey) => {
+      const owner = owners.get(mint.toBase58());
+      return owner ? ({ owner, data: Buffer.alloc(82) } as any) : null;
+    }),
+  };
+}
+
+describe('resolveTokenProgramForMint', () => {
+  afterEach(() => {
+    __clearTokenProgramResolverCacheForTests();
+  });
+
+  it('resolves token-v1 and token-2022 from mint owner', async () => {
+    const mintA = pk(1);
+    const mintB = pk(2);
+    const connection = mockConnection(
+      new Map<string, PublicKey>([
+        [mintA.toBase58(), TOKEN_PROGRAM_ID],
+        [mintB.toBase58(), TOKEN_2022_PROGRAM_ID],
+      ]),
+    );
+
+    const infoA = await resolveTokenProgramForMint(connection as any, mintA);
+    const infoB = await resolveTokenProgramForMint(connection as any, mintB);
+
+    expect(infoA.tokenProgramId.toBase58()).toBe(TOKEN_PROGRAM_ID.toBase58());
+    expect(infoA.isToken2022).toBe(false);
+    expect(infoB.tokenProgramId.toBase58()).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
+    expect(infoB.isToken2022).toBe(true);
+  });
+
+  it('throws non-retryable UNSUPPORTED_MINT_OWNER for unknown owners', async () => {
+    const mint = pk(5);
+    const connection = mockConnection(new Map<string, PublicKey>([[mint.toBase58(), pk(99)]]));
+
+    await expect(resolveTokenProgramForMint(connection as any, mint)).rejects.toMatchObject({
+      code: 'UNSUPPORTED_MINT_OWNER',
+      retryable: false,
+    });
+  });
+
+  it('uses LRU cache with max 512 entries', async () => {
+    const owners = new Map<string, PublicKey>();
+    const mints: PublicKey[] = [];
+    for (let i = 1; i <= 513; i += 1) {
+      const mint = pk(i);
+      mints.push(mint);
+      owners.set(mint.toBase58(), TOKEN_PROGRAM_ID);
+    }
+    const connection = mockConnection(owners);
+
+    for (let i = 0; i < 512; i += 1) {
+      await resolveTokenProgramForMint(connection as any, mints[i]);
+    }
+    expect(__tokenProgramResolverCacheSizeForTests()).toBe(512);
+
+    // Refresh recency for mint[0], then insert one more to evict the old LRU (mint[1]).
+    await resolveTokenProgramForMint(connection as any, mints[0]);
+    await resolveTokenProgramForMint(connection as any, mints[512]);
+    expect(__tokenProgramResolverCacheSizeForTests()).toBe(512);
+
+    // mint[0] should still be cached (no new RPC call), mint[1] should have been evicted (new RPC call).
+    const callsBefore = connection.getAccountInfo.mock.calls.length;
+    await resolveTokenProgramForMint(connection as any, mints[0]);
+    await resolveTokenProgramForMint(connection as any, mints[1]);
+    const callsAfter = connection.getAccountInfo.mock.calls.length;
+    expect(callsAfter - callsBefore).toBe(1);
+  });
+});
diff --git a/packages/solana/src/__tests__/whirlpoolVariant.spec.ts b/packages/solana/src/__tests__/whirlpoolVariant.spec.ts
new file mode 100644
index 0000000..a49ae14
--- /dev/null
+++ b/packages/solana/src/__tests__/whirlpoolVariant.spec.ts
@@ -0,0 +1,56 @@
+import { describe, expect, it } from 'vitest';
+import { PublicKey } from '@solana/web3.js';
+import { buildTokenContext, selectWhirlpoolInstructionVariant } from '../token/whirlpool';
+import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../token/constants';
+
+const pk = (seed: number) => new PublicKey(new Uint8Array(32).fill(seed));
+
+describe('selectWhirlpoolInstructionVariant', () => {
+  it('chooses v1 for token/token', () => {
+    const variant = selectWhirlpoolInstructionVariant(
+      buildTokenContext({
+        mintA: pk(1),
+        mintB: pk(2),
+        tokenProgramA: TOKEN_PROGRAM_ID,
+        tokenProgramB: TOKEN_PROGRAM_ID,
+      }),
+    );
+    expect(variant).toBe('v1');
+  });
+
+  it('chooses v2 for token2022/token', () => {
+    const variant = selectWhirlpoolInstructionVariant(
+      buildTokenContext({
+        mintA: pk(1),
+        mintB: pk(2),
+        tokenProgramA: TOKEN_2022_PROGRAM_ID,
+        tokenProgramB: TOKEN_PROGRAM_ID,
+      }),
+    );
+    expect(variant).toBe('v2');
+  });
+
+  it('chooses v2 for token/token2022', () => {
+    const variant = selectWhirlpoolInstructionVariant(
+      buildTokenContext({
+        mintA: pk(1),
+        mintB: pk(2),
+        tokenProgramA: TOKEN_PROGRAM_ID,
+        tokenProgramB: TOKEN_2022_PROGRAM_ID,
+      }),
+    );
+    expect(variant).toBe('v2');
+  });
+
+  it('chooses v2 for token2022/token2022', () => {
+    const variant = selectWhirlpoolInstructionVariant(
+      buildTokenContext({
+        mintA: pk(1),
+        mintB: pk(2),
+        tokenProgramA: TOKEN_2022_PROGRAM_ID,
+        tokenProgramB: TOKEN_2022_PROGRAM_ID,
+      }),
+    );
+    expect(variant).toBe('v2');
+  });
+});
diff --git a/packages/solana/src/ata.ts b/packages/solana/src/ata.ts
index 2cb78cf..762a8b9 100644
--- a/packages/solana/src/ata.ts
+++ b/packages/solana/src/ata.ts
@@ -1,35 +1,31 @@
 import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
 import {
-  ASSOCIATED_TOKEN_PROGRAM_ID,
-  TOKEN_PROGRAM_ID,
   createAssociatedTokenAccountIdempotentInstruction,
   getAssociatedTokenAddressSync,
 } from '@solana/spl-token';
+import { ASSOCIATED_TOKEN_PROGRAM_ID } from './token/constants';
 
 export const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
 
-export function getAta(mint: PublicKey, owner: PublicKey, tokenProgramId: PublicKey = TOKEN_PROGRAM_ID): PublicKey {
+export type AtaPlanEntry = {
+  ata: PublicKey;
+  mint: PublicKey;
+  owner: PublicKey;
+  tokenProgramId: PublicKey;
+};
+
+export function getAta(mint: PublicKey, owner: PublicKey, tokenProgramId: PublicKey): PublicKey {
   // allowOwnerOffCurve=true so deterministic tests and PDA-like owners do not throw.
   return getAssociatedTokenAddressSync(mint, owner, true, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);
 }
 
-export function buildCreateAtaIdempotentIx(params: {
-  payer: PublicKey;
-  owner: PublicKey;
-  mint: PublicKey;
-  tokenProgramId?: PublicKey;
-}): { ata: PublicKey; ix: TransactionInstruction } {
-  const tokenProgramId = params.tokenProgramId ?? TOKEN_PROGRAM_ID;
-  const ata = getAta(params.mint, params.owner, tokenProgramId);
-  return {
-    ata,
-    ix: createAssociatedTokenAccountIdempotentInstruction(
-      params.payer,
-      ata,
-      params.owner,
-      params.mint,
-      tokenProgramId,
-      ASSOCIATED_TOKEN_PROGRAM_ID,
-    ),
-  };
+export function createAtaIxFromPlan(planEntry: AtaPlanEntry, payer: PublicKey): TransactionInstruction {
+  return createAssociatedTokenAccountIdempotentInstruction(
+    payer,
+    planEntry.ata,
+    planEntry.owner,
+    planEntry.mint,
+    planEntry.tokenProgramId,
+    ASSOCIATED_TOKEN_PROGRAM_ID,
+  );
 }
diff --git a/packages/solana/src/e2eDevnet.ts b/packages/solana/src/e2eDevnet.ts
index 33b76f4..266fb00 100644
--- a/packages/solana/src/e2eDevnet.ts
+++ b/packages/solana/src/e2eDevnet.ts
@@ -26,6 +26,7 @@ import { resolveReceiptRuntimeIdentity, type ReceiptRuntimeIdentity } from './re
 import { verifyReceiptProgramOnChain } from './receiptProgramVerification';
 import { getSwapAdapter } from './swap/registry';
 import { deriveSwapTickArrays } from './swap/tickArrays';
+import { TOKEN_2022_PROGRAM_ID } from './token/constants';
 
 export type HarnessDecision = 'HOLD' | 'TRIGGER_DOWN' | 'TRIGGER_UP';
 
@@ -85,6 +86,11 @@ function parseOptionalEnv(env: HarnessEnv, key: 'POSITION_ADDRESS' | 'POSITION_A
   return value ? value : undefined;
 }
 
+function parseOptionalToken2022Position(env: HarnessEnv): string | undefined {
+  const value = env.TOKEN2022_POSITION_ADDRESS?.trim();
+  return value ? value : undefined;
+}
+
 function parsePublicKeyValue(value: string, key: 'POSITION_ADDRESS' | 'POSITION_ADDRESS_CANDIDATES'): PublicKey {
   try {
     return new PublicKey(value);
@@ -356,6 +362,55 @@ async function resolveHarnessPosition(params: {
   throw codedError('CONFIG_INVALID', `No candidate positions available for receipt proof (${summary})`);
 }
 
+async function runOptionalToken2022Scenario(params: {
+  env: HarnessEnv;
+  connection: Connection;
+  deps: HarnessDeps;
+  logger: HarnessLogger;
+}): Promise<void> {
+  const rawPosition = parseOptionalToken2022Position(params.env);
+  if (!rawPosition) {
+    log(params.logger, 'token2022.optional.skip', { reason: 'NOT_CONFIGURED' });
+    return;
+  }
+
+  let position: PublicKey;
+  try {
+    position = new PublicKey(rawPosition);
+  } catch {
+    log(params.logger, 'token2022.optional.skip', { reason: 'INVALID_POSITION_ADDRESS' });
+    return;
+  }
+
+  try {
+    const snapshot = await params.deps.loadPositionSnapshot(params.connection, position, 'devnet');
+    const hasToken2022 =
+      snapshot.tokenProgramA.equals(TOKEN_2022_PROGRAM_ID) || snapshot.tokenProgramB.equals(TOKEN_2022_PROGRAM_ID);
+    if (!hasToken2022) {
+      log(params.logger, 'token2022.optional.skip', {
+        reason: 'NO_TOKEN2022_MINT',
+        position: position.toBase58(),
+        tokenProgramA: snapshot.tokenProgramA.toBase58(),
+        tokenProgramB: snapshot.tokenProgramB.toBase58(),
+      });
+      return;
+    }
+
+    log(params.logger, 'token2022.optional.ok', {
+      position: position.toBase58(),
+      tokenProgramA: snapshot.tokenProgramA.toBase58(),
+      tokenProgramB: snapshot.tokenProgramB.toBase58(),
+    });
+  } catch (error) {
+    const err = error as HarnessError;
+    log(params.logger, 'token2022.optional.skip', {
+      reason: err.code ?? 'LOAD_FAILED',
+      message: err.message,
+      position: position.toBase58(),
+    });
+  }
+}
+
 export async function runDevnetE2E(
   env: HarnessEnv = process.env,
   logger: HarnessLogger = (entry) => console.log(JSON.stringify(entry)),
@@ -440,6 +495,7 @@ export async function runDevnetE2E(
   log(logger, 'policy.evaluate.ok', { decision, reasonCode });
 
   if (decision === 'HOLD') {
+    await runOptionalToken2022Scenario({ env, connection, deps, logger });
     if (requireReceiptProof) {
       throw codedError(
         'RECEIPT_PROGRAM_VERIFICATION_FAILED',
@@ -640,5 +696,6 @@ export async function runDevnetE2E(
   }
   log(logger, 'receipt.duplicate-block.ok', { code: duplicateResult.errorCode });
 
+  await runOptionalToken2022Scenario({ env, connection, deps, logger });
   log(logger, 'harness.complete', { status: 'EXECUTED', signature: result.txSignature });
 }
diff --git a/packages/solana/src/errors.ts b/packages/solana/src/errors.ts
index 5200836..297bb42 100644
--- a/packages/solana/src/errors.ts
+++ b/packages/solana/src/errors.ts
@@ -3,6 +3,7 @@ import type { CanonicalErrorCode, NormalizedError } from './types';
 const transientHints = ['timeout', '429', 'rate limit', 'temporarily unavailable', 'econnreset'];
 const CANONICAL_CODES: CanonicalErrorCode[] = [
   'DATA_UNAVAILABLE',
+  'UNSUPPORTED_MINT_OWNER',
   'RPC_TRANSIENT',
   'RPC_PERMANENT',
   'INVALID_POSITION',
diff --git a/packages/solana/src/executionBuilder.ts b/packages/solana/src/executionBuilder.ts
index 37a3a1b..3b36626 100644
--- a/packages/solana/src/executionBuilder.ts
+++ b/packages/solana/src/executionBuilder.ts
@@ -6,9 +6,8 @@ import {
   type AddressLookupTableAccount,
   type TransactionInstruction,
 } from '@solana/web3.js';
-import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
 import { assertSolUsdcPair, decideSwap, hashAttestationPayload, type SwapPlan } from '@clmm-autopilot/core';
-import { buildCreateAtaIdempotentIx, SOL_MINT } from './ata';
+import { createAtaIxFromPlan, SOL_MINT } from './ata';
 import type { PositionSnapshot } from './orcaInspector';
 import { buildOrcaExitIxs, type OrcaExitIxs } from './orcaExitBuilder';
 import { buildRecordExecutionIx } from './receipt';
@@ -119,12 +118,6 @@ function buildComputeBudgetIxs(cfg: BuildExitConfig): TransactionInstruction[] {
   ];
 }
 
-function tokenProgramForMint(mint: PublicKey, snapshot: PositionSnapshot): PublicKey {
-  if (mint.equals(snapshot.tokenMintA)) return snapshot.tokenProgramA;
-  if (mint.equals(snapshot.tokenMintB)) return snapshot.tokenProgramB;
-  return TOKEN_PROGRAM_ID;
-}
-
 export async function buildExitTransaction(
   snapshot: PositionSnapshot,
   direction: ExitDirection,
@@ -219,27 +212,7 @@ export async function buildExitTransaction(
       ? buildWsol({ quote: { inputMint: quoteIn, outputMint: quoteOut, inAmount: normalizedPlan.quote.swapInAmount }, authority: config.authority, payer: config.payer })
       : { preSwap: [], postSwap: [], wsolAta: undefined };
 
-  const swapAtaIxs: TransactionInstruction[] = [];
-  if (shouldExecuteSwap && !quoteIn.equals(SOL_MINT)) {
-    swapAtaIxs.push(
-      buildCreateAtaIdempotentIx({
-        payer: config.payer,
-        owner: config.authority,
-        mint: quoteIn,
-        tokenProgramId: tokenProgramForMint(quoteIn, snapshot),
-      }).ix,
-    );
-  }
-  if (shouldExecuteSwap && !quoteOut.equals(SOL_MINT)) {
-    swapAtaIxs.push(
-      buildCreateAtaIdempotentIx({
-        payer: config.payer,
-        owner: config.authority,
-        mint: quoteOut,
-        tokenProgramId: tokenProgramForMint(quoteOut, snapshot),
-      }).ix,
-    );
-  }
+  const ataPlanIxs = config.requirements.missingAtas.map((entry) => createAtaIxFromPlan(entry, config.payer));
 
   const receiptIx = config.receiptProgramId
     ? buildRecordExecutionIx({
@@ -255,8 +228,7 @@ export async function buildExitTransaction(
 
   const instructions: TransactionInstruction[] = [
     ...buildComputeBudgetIxs(config),
-    ...orca.conditionalAtaIxs,
-    ...swapAtaIxs,
+    ...ataPlanIxs,
     ...(wsolRequired ? wsolLifecycle.preSwap : []),
     orca.removeLiquidityIx,
     orca.collectFeesIx,
diff --git a/packages/solana/src/index.ts b/packages/solana/src/index.ts
index ee5c8a5..abe283f 100644
--- a/packages/solana/src/index.ts
+++ b/packages/solana/src/index.ts
@@ -13,6 +13,9 @@ export * from './simErrors';
 export * from './executeOnce';
 export * from './requirements';
 export * from './orca/decode';
+export * from './token/constants';
+export * from './token/program';
+export * from './token/whirlpool';
 export * from './swap/types';
 export * from './swap/registry';
 export * from './swap/tickArrays';
diff --git a/packages/solana/src/orcaExitBuilder.ts b/packages/solana/src/orcaExitBuilder.ts
index a2ac64b..822567f 100644
--- a/packages/solana/src/orcaExitBuilder.ts
+++ b/packages/solana/src/orcaExitBuilder.ts
@@ -1,15 +1,25 @@
 import { PublicKey, TransactionInstruction, type AccountMeta } from '@solana/web3.js';
-import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
 import type { PositionSnapshot } from './orcaInspector';
-import { buildCreateAtaIdempotentIx, getAta } from './ata';
+import { getAta } from './ata';
+import { MEMO_PROGRAM_ID, TOKEN_PROGRAM_ID } from './token/constants';
+import {
+  INCLUDE_MEMO_ON_V2,
+  buildTokenContext,
+  selectWhirlpoolInstructionVariant,
+  type WhirlpoolInstructionVariant,
+} from './token/whirlpool';
+import type { CanonicalErrorCode } from './types';
 
 export const ORCA_WHIRLPOOL_PROGRAM_ID = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
-const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
 
-// Whirlpool IDL discriminators (v2 instructions) for deterministic TS-side construction.
+// Whirlpool IDL discriminators for deterministic TS-side construction.
+const DISCRIMINATOR_DECREASE_LIQUIDITY = Buffer.from([160, 38, 208, 111, 104, 91, 44, 1]);
 const DISCRIMINATOR_DECREASE_LIQUIDITY_V2 = Buffer.from([58, 127, 188, 62, 79, 82, 196, 96]);
+const DISCRIMINATOR_COLLECT_FEES = Buffer.from([164, 152, 207, 99, 30, 186, 19, 182]);
 const DISCRIMINATOR_COLLECT_FEES_V2 = Buffer.from([207, 117, 95, 191, 229, 180, 226, 15]);
 
+type TypedError = Error & { code: CanonicalErrorCode; retryable: boolean; debug?: unknown };
+
 function writeU64LE(v: bigint): Buffer {
   const b = Buffer.alloc(8);
   let n = BigInt.asUintN(64, v);
@@ -37,8 +47,16 @@ function writeU128LE(v: bigint): Buffer {
   return b;
 }
 
+function fail(code: CanonicalErrorCode, message: string, debug?: unknown): never {
+  const err = new Error(message) as TypedError;
+  err.code = code;
+  err.retryable = false;
+  if (debug !== undefined) err.debug = debug;
+  throw err;
+}
+
 export type OrcaExitIxs = {
-  conditionalAtaIxs: TransactionInstruction[];
+  variant: WhirlpoolInstructionVariant;
   removeLiquidityIx: TransactionInstruction;
   collectFeesIx: TransactionInstruction;
   tokenOwnerAccountA: PublicKey;
@@ -51,75 +69,117 @@ export function buildOrcaExitIxs(params: {
   authority: PublicKey;
   payer: PublicKey;
 }): OrcaExitIxs {
-  const positionTokenProgram = params.snapshot.positionTokenProgram ?? TOKEN_PROGRAM_ID;
+  const positionTokenProgram = params.snapshot.positionTokenProgram;
+  if (!positionTokenProgram) {
+    fail('DATA_UNAVAILABLE', 'position token program unavailable', {
+      positionMint: params.snapshot.positionMint.toBase58(),
+      position: params.snapshot.position.toBase58(),
+    });
+  }
+
   const positionTokenAccount = getAta(params.snapshot.positionMint, params.authority, positionTokenProgram);
   const ownerA = getAta(params.snapshot.tokenMintA, params.authority, params.snapshot.tokenProgramA);
   const ownerB = getAta(params.snapshot.tokenMintB, params.authority, params.snapshot.tokenProgramB);
+  const tokenContext = buildTokenContext({
+    mintA: params.snapshot.tokenMintA,
+    mintB: params.snapshot.tokenMintB,
+    tokenProgramA: params.snapshot.tokenProgramA,
+    tokenProgramB: params.snapshot.tokenProgramB,
+  });
+  const variant = selectWhirlpoolInstructionVariant(tokenContext);
 
-  const conditionalAtaIxs: TransactionInstruction[] = [
-    buildCreateAtaIdempotentIx({
-      payer: params.payer,
-      owner: params.authority,
-      mint: params.snapshot.positionMint,
-      tokenProgramId: positionTokenProgram,
-    }).ix,
-    buildCreateAtaIdempotentIx({ payer: params.payer, owner: params.authority, mint: params.snapshot.tokenMintA, tokenProgramId: params.snapshot.tokenProgramA }).ix,
-    buildCreateAtaIdempotentIx({ payer: params.payer, owner: params.authority, mint: params.snapshot.tokenMintB, tokenProgramId: params.snapshot.tokenProgramB }).ix,
-  ];
-
-  const removeKeys: AccountMeta[] = [
-    { pubkey: params.snapshot.whirlpool, isSigner: false, isWritable: true },
-    { pubkey: params.snapshot.tokenProgramA, isSigner: false, isWritable: false },
-    { pubkey: params.snapshot.tokenProgramB, isSigner: false, isWritable: false },
-    { pubkey: MEMO_PROGRAM_ID, isSigner: false, isWritable: false },
-    { pubkey: params.authority, isSigner: true, isWritable: false },
-    { pubkey: params.snapshot.position, isSigner: false, isWritable: true },
-    { pubkey: positionTokenAccount, isSigner: false, isWritable: false },
-    { pubkey: params.snapshot.tokenMintA, isSigner: false, isWritable: false },
-    { pubkey: params.snapshot.tokenMintB, isSigner: false, isWritable: false },
-    { pubkey: ownerA, isSigner: false, isWritable: true },
-    { pubkey: ownerB, isSigner: false, isWritable: true },
-    { pubkey: params.snapshot.tokenVaultA, isSigner: false, isWritable: true },
-    { pubkey: params.snapshot.tokenVaultB, isSigner: false, isWritable: true },
-    { pubkey: params.snapshot.tickArrayLower, isSigner: false, isWritable: true },
-    { pubkey: params.snapshot.tickArrayUpper, isSigner: false, isWritable: true },
-  ];
+  const removeKeys: AccountMeta[] =
+    variant === 'v2'
+      ? [
+          { pubkey: params.snapshot.whirlpool, isSigner: false, isWritable: true },
+          { pubkey: params.snapshot.tokenProgramA, isSigner: false, isWritable: false },
+          { pubkey: params.snapshot.tokenProgramB, isSigner: false, isWritable: false },
+          ...(INCLUDE_MEMO_ON_V2 ? [{ pubkey: MEMO_PROGRAM_ID, isSigner: false, isWritable: false }] : []),
+          { pubkey: params.authority, isSigner: true, isWritable: false },
+          { pubkey: params.snapshot.position, isSigner: false, isWritable: true },
+          { pubkey: positionTokenAccount, isSigner: false, isWritable: false },
+          { pubkey: params.snapshot.tokenMintA, isSigner: false, isWritable: false },
+          { pubkey: params.snapshot.tokenMintB, isSigner: false, isWritable: false },
+          { pubkey: ownerA, isSigner: false, isWritable: true },
+          { pubkey: ownerB, isSigner: false, isWritable: true },
+          { pubkey: params.snapshot.tokenVaultA, isSigner: false, isWritable: true },
+          { pubkey: params.snapshot.tokenVaultB, isSigner: false, isWritable: true },
+          { pubkey: params.snapshot.tickArrayLower, isSigner: false, isWritable: true },
+          { pubkey: params.snapshot.tickArrayUpper, isSigner: false, isWritable: true },
+        ]
+      : [
+          { pubkey: params.snapshot.whirlpool, isSigner: false, isWritable: true },
+          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
+          { pubkey: params.authority, isSigner: true, isWritable: false },
+          { pubkey: params.snapshot.position, isSigner: false, isWritable: true },
+          { pubkey: positionTokenAccount, isSigner: false, isWritable: false },
+          { pubkey: ownerA, isSigner: false, isWritable: true },
+          { pubkey: ownerB, isSigner: false, isWritable: true },
+          { pubkey: params.snapshot.tokenVaultA, isSigner: false, isWritable: true },
+          { pubkey: params.snapshot.tokenVaultB, isSigner: false, isWritable: true },
+          { pubkey: params.snapshot.tickArrayLower, isSigner: false, isWritable: true },
+          { pubkey: params.snapshot.tickArrayUpper, isSigner: false, isWritable: true },
+        ];
 
   const liquidityAmount = params.snapshot.liquidity;
-  const data = Buffer.concat([
-    DISCRIMINATOR_DECREASE_LIQUIDITY_V2,
-    writeU128LE(liquidityAmount),
-    writeU64LE(BigInt(0)),
-    writeU64LE(BigInt(0)),
-    Buffer.from([0]), // Option<RemainingAccountsInfo> = None
-  ]);
+  const data =
+    variant === 'v2'
+      ? Buffer.concat([
+          DISCRIMINATOR_DECREASE_LIQUIDITY_V2,
+          writeU128LE(liquidityAmount),
+          writeU64LE(BigInt(0)),
+          writeU64LE(BigInt(0)),
+          Buffer.from([0]), // Option<RemainingAccountsInfo> = None
+        ])
+      : Buffer.concat([
+          DISCRIMINATOR_DECREASE_LIQUIDITY,
+          writeU128LE(liquidityAmount),
+          writeU64LE(BigInt(0)),
+          writeU64LE(BigInt(0)),
+        ]);
 
   const removeLiquidityIx = new TransactionInstruction({ programId: ORCA_WHIRLPOOL_PROGRAM_ID, keys: removeKeys, data });
 
-  const collectKeys: AccountMeta[] = [
-    { pubkey: params.snapshot.whirlpool, isSigner: false, isWritable: false },
-    { pubkey: params.authority, isSigner: true, isWritable: false },
-    { pubkey: params.snapshot.position, isSigner: false, isWritable: true },
-    { pubkey: positionTokenAccount, isSigner: false, isWritable: false },
-    { pubkey: params.snapshot.tokenMintA, isSigner: false, isWritable: false },
-    { pubkey: params.snapshot.tokenMintB, isSigner: false, isWritable: false },
-    { pubkey: ownerA, isSigner: false, isWritable: true },
-    { pubkey: params.snapshot.tokenVaultA, isSigner: false, isWritable: true },
-    { pubkey: ownerB, isSigner: false, isWritable: true },
-    { pubkey: params.snapshot.tokenVaultB, isSigner: false, isWritable: true },
-    { pubkey: params.snapshot.tokenProgramA, isSigner: false, isWritable: false },
-    { pubkey: params.snapshot.tokenProgramB, isSigner: false, isWritable: false },
-    { pubkey: MEMO_PROGRAM_ID, isSigner: false, isWritable: false },
-  ];
+  const collectKeys: AccountMeta[] =
+    variant === 'v2'
+      ? [
+          { pubkey: params.snapshot.whirlpool, isSigner: false, isWritable: false },
+          { pubkey: params.authority, isSigner: true, isWritable: false },
+          { pubkey: params.snapshot.position, isSigner: false, isWritable: true },
+          { pubkey: positionTokenAccount, isSigner: false, isWritable: false },
+          { pubkey: params.snapshot.tokenMintA, isSigner: false, isWritable: false },
+          { pubkey: params.snapshot.tokenMintB, isSigner: false, isWritable: false },
+          { pubkey: ownerA, isSigner: false, isWritable: true },
+          { pubkey: params.snapshot.tokenVaultA, isSigner: false, isWritable: true },
+          { pubkey: ownerB, isSigner: false, isWritable: true },
+          { pubkey: params.snapshot.tokenVaultB, isSigner: false, isWritable: true },
+          { pubkey: params.snapshot.tokenProgramA, isSigner: false, isWritable: false },
+          { pubkey: params.snapshot.tokenProgramB, isSigner: false, isWritable: false },
+          ...(INCLUDE_MEMO_ON_V2 ? [{ pubkey: MEMO_PROGRAM_ID, isSigner: false, isWritable: false }] : []),
+        ]
+      : [
+          { pubkey: params.snapshot.whirlpool, isSigner: false, isWritable: false },
+          { pubkey: params.authority, isSigner: true, isWritable: false },
+          { pubkey: params.snapshot.position, isSigner: false, isWritable: true },
+          { pubkey: positionTokenAccount, isSigner: false, isWritable: false },
+          { pubkey: ownerA, isSigner: false, isWritable: true },
+          { pubkey: params.snapshot.tokenVaultA, isSigner: false, isWritable: true },
+          { pubkey: ownerB, isSigner: false, isWritable: true },
+          { pubkey: params.snapshot.tokenVaultB, isSigner: false, isWritable: true },
+          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
+        ];
 
   const collectFeesIx = new TransactionInstruction({
     programId: ORCA_WHIRLPOOL_PROGRAM_ID,
     keys: collectKeys,
-    data: Buffer.concat([DISCRIMINATOR_COLLECT_FEES_V2, Buffer.from([0])]), // RemainingAccountsInfo = None
+    data:
+      variant === 'v2'
+        ? Buffer.concat([DISCRIMINATOR_COLLECT_FEES_V2, Buffer.from([0])]) // RemainingAccountsInfo = None
+        : DISCRIMINATOR_COLLECT_FEES,
   });
 
   return {
-    conditionalAtaIxs,
+    variant,
     removeLiquidityIx,
     collectFeesIx,
     tokenOwnerAccountA: ownerA,
diff --git a/packages/solana/src/orcaInspector.ts b/packages/solana/src/orcaInspector.ts
index b3bc843..c8a5dd2 100644
--- a/packages/solana/src/orcaInspector.ts
+++ b/packages/solana/src/orcaInspector.ts
@@ -7,16 +7,14 @@ import {
   PDAUtil,
   PriceMath,
 } from '@orca-so/whirlpools-sdk';
-import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
 import { PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';
 import { normalizeSolanaError } from './errors';
 import { loadSolanaConfig } from './config';
 import { decodePositionAccount, decodeWhirlpoolAccount } from './orca/decode';
+import { tokenProgramInfoFromMintOwner } from './token/program';
 import type { CanonicalErrorCode, NormalizedError } from './types';
 
 const ORCA_WHIRLPOOL_PROGRAM_ID = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
-const TOKEN_PROGRAM_V1 = TOKEN_PROGRAM_ID;
-const TOKEN_PROGRAM_2022 = TOKEN_2022_PROGRAM_ID;
 
 export type RemovePreviewReasonCode = 'QUOTE_UNAVAILABLE' | 'DATA_UNAVAILABLE';
 
@@ -130,9 +128,8 @@ function parseMintMeta(info: AccountInfo<Buffer> | null): MintMeta {
   };
 }
 
-function tokenProgramForOwner(owner: PublicKey): PublicKey {
-  if (owner.equals(TOKEN_PROGRAM_2022)) return TOKEN_PROGRAM_2022;
-  return TOKEN_PROGRAM_V1;
+function tokenProgramForMintOwner(mintPubkey: PublicKey, owner: PublicKey): PublicKey {
+  return tokenProgramInfoFromMintOwner(mintPubkey, owner).tokenProgramId;
 }
 
 function deriveTickArrayFromTickIndex(whirlpool: PublicKey, tickIndex: number, tickSpacing: number): PublicKey {
@@ -250,7 +247,7 @@ export async function loadPositionSnapshot(
       whirlpool: position.whirlpool,
       position: positionPubkey,
       positionMint: position.positionMint,
-      positionTokenProgram: tokenProgramForOwner(positionMintMeta.owner),
+      positionTokenProgram: tokenProgramForMintOwner(position.positionMint, positionMintMeta.owner),
       currentTickIndex: whirlpool.currentTickIndex,
       lowerTickIndex: position.lowerTickIndex,
       upperTickIndex: position.upperTickIndex,
@@ -267,8 +264,8 @@ export async function loadPositionSnapshot(
       tokenVaultB: whirlpool.tokenVaultB,
       tickArrayLower,
       tickArrayUpper,
-      tokenProgramA: tokenProgramForOwner(mintA.owner),
-      tokenProgramB: tokenProgramForOwner(mintB.owner),
+      tokenProgramA: tokenProgramForMintOwner(whirlpool.tokenMintA, mintA.owner),
+      tokenProgramB: tokenProgramForMintOwner(whirlpool.tokenMintB, mintB.owner),
       removePreview: removePreviewResult.preview,
       removePreviewReasonCode: removePreviewResult.reasonCode,
     };
diff --git a/packages/solana/src/requirements.ts b/packages/solana/src/requirements.ts
index c6ed84f..2c93cc3 100644
--- a/packages/solana/src/requirements.ts
+++ b/packages/solana/src/requirements.ts
@@ -1,11 +1,14 @@
 import type { Connection, PublicKey } from '@solana/web3.js';
-import { AccountLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token';
+import { AccountLayout } from '@solana/spl-token';
 import type { PositionSnapshot } from './orcaInspector';
-import { getAta, SOL_MINT } from './ata';
+import { type AtaPlanEntry, getAta, SOL_MINT } from './ata';
+import { resolveTokenProgramForMint } from './token/program';
+import { TOKEN_PROGRAM_ID } from './token/constants';
 
 export type FeeRequirementsBreakdown = {
   rentLamports: number;
   ataCount: number;
+  missingAtas: AtaPlanEntry[];
   txFeeLamports: number;
   priorityFeeLamports: number;
   totalRequiredLamports: number;
@@ -45,33 +48,53 @@ async function accountExists(connection: Pick<Connection, 'getAccountInfo'>, pub
 export async function computeExecutionRequirements(input: RequirementsInput): Promise<FeeRequirementsBreakdown> {
   const involvesSol = input.quote.inputMint.equals(SOL_MINT) || input.quote.outputMint.equals(SOL_MINT);
 
-  const ataAddresses = new Map<string, PublicKey>();
-  const addAta = (mint: PublicKey, tokenProgramId: PublicKey = TOKEN_PROGRAM_ID) => {
+  const ataPlans = new Map<string, AtaPlanEntry>();
+  const addAta = (mint: PublicKey, tokenProgramId: PublicKey) => {
     const ata = getAta(mint, input.authority, tokenProgramId);
-    ataAddresses.set(ata.toBase58(), ata);
+    const key = ata.toBase58();
+    if (ataPlans.has(key)) return;
+    ataPlans.set(key, {
+      ata,
+      mint,
+      owner: input.authority,
+      tokenProgramId,
+    });
   };
 
   // Orca exit always needs these token accounts (position token + the pool mints A/B).
-  addAta(input.snapshot.positionMint, input.snapshot.positionTokenProgram ?? TOKEN_PROGRAM_ID);
+  const positionTokenProgramId =
+    input.snapshot.positionTokenProgram ?? (await resolveTokenProgramForMint(input.connection, input.snapshot.positionMint)).tokenProgramId;
+  addAta(input.snapshot.positionMint, positionTokenProgramId);
   addAta(input.snapshot.tokenMintA, input.snapshot.tokenProgramA);
   addAta(input.snapshot.tokenMintB, input.snapshot.tokenProgramB);
 
   if (input.swapPlanned) {
+    const resolveQuoteTokenProgramId = async (mint: PublicKey): Promise<PublicKey> => {
+      if (mint.equals(input.snapshot.tokenMintA)) return input.snapshot.tokenProgramA;
+      if (mint.equals(input.snapshot.tokenMintB)) return input.snapshot.tokenProgramB;
+      return (await resolveTokenProgramForMint(input.connection, mint)).tokenProgramId;
+    };
+
     // Swap ATAs for input/output mints when those are SPL tokens.
-    if (!input.quote.inputMint.equals(SOL_MINT)) addAta(input.quote.inputMint);
-    if (!input.quote.outputMint.equals(SOL_MINT)) addAta(input.quote.outputMint);
+    if (!input.quote.inputMint.equals(SOL_MINT)) {
+      addAta(input.quote.inputMint, await resolveQuoteTokenProgramId(input.quote.inputMint));
+    }
+    if (!input.quote.outputMint.equals(SOL_MINT)) {
+      addAta(input.quote.outputMint, await resolveQuoteTokenProgramId(input.quote.outputMint));
+    }
     // WSOL ATA when swap involves SOL (wrap/unwrap lifecycle uses native mint ATA).
     if (involvesSol) addAta(SOL_MINT, TOKEN_PROGRAM_ID);
   }
 
-  const uniqueAtas = Array.from(ataAddresses.values());
+  const plannedAtas = Array.from(ataPlans.values());
 
-  const exists = await Promise.all(uniqueAtas.map((k) => accountExists(input.connection, k)));
-  const missingAtas = exists.reduce((acc, ok) => acc + (ok ? 0 : 1), 0);
+  const exists = await Promise.all(plannedAtas.map((entry) => accountExists(input.connection, entry.ata)));
+  const missingAtas = plannedAtas.filter((_, i) => !exists[i]);
+  const missingAtaCount = missingAtas.length;
 
   // All ATAs are SPL Token accounts, same size.
   const tokenAccountRent = await input.connection.getMinimumBalanceForRentExemption(AccountLayout.span);
-  const rentLamports = tokenAccountRent * missingAtas;
+  const rentLamports = tokenAccountRent * missingAtaCount;
 
   const computeUnitLimit = input.computeUnitLimit ?? 0;
   const computeUnitPriceMicroLamports = input.computeUnitPriceMicroLamports ?? 0;
@@ -81,7 +104,8 @@ export async function computeExecutionRequirements(input: RequirementsInput): Pr
 
   return {
     rentLamports,
-    ataCount: missingAtas,
+    ataCount: missingAtaCount,
+    missingAtas,
     txFeeLamports: input.txFeeLamports,
     priorityFeeLamports,
     totalRequiredLamports,
diff --git a/packages/solana/src/swap/orca/OrcaWhirlpoolSwapAdapter.ts b/packages/solana/src/swap/orca/OrcaWhirlpoolSwapAdapter.ts
index 3a923ff..5b79b36 100644
--- a/packages/solana/src/swap/orca/OrcaWhirlpoolSwapAdapter.ts
+++ b/packages/solana/src/swap/orca/OrcaWhirlpoolSwapAdapter.ts
@@ -11,6 +11,7 @@ import {
 } from '@orca-so/whirlpools-sdk';
 import { PublicKey } from '@solana/web3.js';
 import { getAta } from '../../ata';
+import { INCLUDE_MEMO_ON_V2, buildTokenContext, selectWhirlpoolInstructionVariant } from '../../token/whirlpool';
 import type { CanonicalErrorCode } from '../../types';
 import type { SolanaGetQuoteParams, SolanaSwapAdapter, SolanaSwapContext } from '../types';
 import type { SolanaSwapBuildResult } from '../types';
@@ -142,29 +143,58 @@ export class OrcaWhirlpoolSwapAdapter implements SolanaSwapAdapter {
     const q = asOrcaDebug(quote);
     const wallet = new ReadOnlyWallet(payer);
     const ctx = WhirlpoolContext.from(context.connection, wallet);
-
-    const ix = WhirlpoolIx.swapV2Ix(ctx.program, {
-      amount: new BN(q.amount),
-      otherAmountThreshold: new BN(q.otherAmountThreshold),
-      sqrtPriceLimit: new BN(q.sqrtPriceLimit),
-      amountSpecifiedIsInput: q.amountSpecifiedIsInput,
-      aToB: q.aToB,
-      tickArray0: new PublicKey(q.tickArray0),
-      tickArray1: new PublicKey(q.tickArray1),
-      tickArray2: new PublicKey(q.tickArray2),
-      supplementalTickArrays: q.supplementalTickArrays.map((k) => new PublicKey(k)),
-      whirlpool: context.whirlpool,
-      tokenMintA: context.tokenMintA,
-      tokenMintB: context.tokenMintB,
-      tokenOwnerAccountA: getAta(context.tokenMintA, payer, context.tokenProgramA),
-      tokenOwnerAccountB: getAta(context.tokenMintB, payer, context.tokenProgramB),
-      tokenVaultA: context.tokenVaultA,
-      tokenVaultB: context.tokenVaultB,
+    const tokenContext = buildTokenContext({
+      mintA: context.tokenMintA,
+      mintB: context.tokenMintB,
       tokenProgramA: context.tokenProgramA,
       tokenProgramB: context.tokenProgramB,
-      oracle: PDAUtil.getOracle(ORCA_WHIRLPOOL_PROGRAM_ID, context.whirlpool).publicKey,
-      tokenAuthority: payer,
     });
+    const variant = selectWhirlpoolInstructionVariant(tokenContext);
+    if (variant === 'v2' && !INCLUDE_MEMO_ON_V2) {
+      fail('DATA_UNAVAILABLE', 'swap v2 requires memo inclusion policy to be enabled', false);
+    }
+
+    const ix =
+      variant === 'v2'
+        ? WhirlpoolIx.swapV2Ix(ctx.program, {
+            amount: new BN(q.amount),
+            otherAmountThreshold: new BN(q.otherAmountThreshold),
+            sqrtPriceLimit: new BN(q.sqrtPriceLimit),
+            amountSpecifiedIsInput: q.amountSpecifiedIsInput,
+            aToB: q.aToB,
+            tickArray0: new PublicKey(q.tickArray0),
+            tickArray1: new PublicKey(q.tickArray1),
+            tickArray2: new PublicKey(q.tickArray2),
+            supplementalTickArrays: q.supplementalTickArrays.map((k) => new PublicKey(k)),
+            whirlpool: context.whirlpool,
+            tokenMintA: context.tokenMintA,
+            tokenMintB: context.tokenMintB,
+            tokenOwnerAccountA: getAta(context.tokenMintA, payer, context.tokenProgramA),
+            tokenOwnerAccountB: getAta(context.tokenMintB, payer, context.tokenProgramB),
+            tokenVaultA: context.tokenVaultA,
+            tokenVaultB: context.tokenVaultB,
+            tokenProgramA: context.tokenProgramA,
+            tokenProgramB: context.tokenProgramB,
+            oracle: PDAUtil.getOracle(ORCA_WHIRLPOOL_PROGRAM_ID, context.whirlpool).publicKey,
+            tokenAuthority: payer,
+          })
+        : WhirlpoolIx.swapIx(ctx.program, {
+            amount: new BN(q.amount),
+            otherAmountThreshold: new BN(q.otherAmountThreshold),
+            sqrtPriceLimit: new BN(q.sqrtPriceLimit),
+            amountSpecifiedIsInput: q.amountSpecifiedIsInput,
+            aToB: q.aToB,
+            tickArray0: new PublicKey(q.tickArray0),
+            tickArray1: new PublicKey(q.tickArray1),
+            tickArray2: new PublicKey(q.tickArray2),
+            whirlpool: context.whirlpool,
+            tokenOwnerAccountA: getAta(context.tokenMintA, payer, context.tokenProgramA),
+            tokenOwnerAccountB: getAta(context.tokenMintB, payer, context.tokenProgramB),
+            tokenVaultA: context.tokenVaultA,
+            tokenVaultB: context.tokenVaultB,
+            oracle: PDAUtil.getOracle(ORCA_WHIRLPOOL_PROGRAM_ID, context.whirlpool).publicKey,
+            tokenAuthority: payer,
+          });
 
     return {
       instructions: [...ix.instructions, ...ix.cleanupInstructions],
diff --git a/packages/solana/src/token/constants.ts b/packages/solana/src/token/constants.ts
new file mode 100644
index 0000000..f8b0f75
--- /dev/null
+++ b/packages/solana/src/token/constants.ts
@@ -0,0 +1,11 @@
+import {
+  ASSOCIATED_TOKEN_PROGRAM_ID as SPL_ASSOCIATED_TOKEN_PROGRAM_ID,
+  TOKEN_2022_PROGRAM_ID as SPL_TOKEN_2022_PROGRAM_ID,
+  TOKEN_PROGRAM_ID as SPL_TOKEN_PROGRAM_ID,
+} from '@solana/spl-token';
+import { PublicKey } from '@solana/web3.js';
+
+export const TOKEN_PROGRAM_ID = SPL_TOKEN_PROGRAM_ID;
+export const TOKEN_2022_PROGRAM_ID = SPL_TOKEN_2022_PROGRAM_ID;
+export const ASSOCIATED_TOKEN_PROGRAM_ID = SPL_ASSOCIATED_TOKEN_PROGRAM_ID;
+export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
diff --git a/packages/solana/src/token/program.ts b/packages/solana/src/token/program.ts
new file mode 100644
index 0000000..e644072
--- /dev/null
+++ b/packages/solana/src/token/program.ts
@@ -0,0 +1,85 @@
+import type { Connection, PublicKey } from '@solana/web3.js';
+import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './constants';
+import type { CanonicalErrorCode } from '../types';
+
+type TypedError = Error & { code: CanonicalErrorCode; retryable: boolean; debug?: unknown };
+
+export type TokenProgramInfo = {
+  tokenProgramId: PublicKey;
+  isToken2022: boolean;
+  mintPubkey: PublicKey;
+};
+
+type ReadonlyConnection = Pick<Connection, 'getAccountInfo'>;
+
+const TOKEN_PROGRAM_CACHE_MAX_ENTRIES = 512;
+const tokenProgramResolverCache = new Map<string, TokenProgramInfo>();
+
+function fail(code: CanonicalErrorCode, message: string, retryable: boolean, debug?: unknown): never {
+  const err = new Error(message) as TypedError;
+  err.code = code;
+  err.retryable = retryable;
+  if (debug !== undefined) err.debug = debug;
+  throw err;
+}
+
+function cacheSet(key: string, value: TokenProgramInfo): void {
+  if (tokenProgramResolverCache.has(key)) tokenProgramResolverCache.delete(key);
+  tokenProgramResolverCache.set(key, value);
+  if (tokenProgramResolverCache.size <= TOKEN_PROGRAM_CACHE_MAX_ENTRIES) return;
+  const oldest = tokenProgramResolverCache.keys().next().value;
+  if (oldest) tokenProgramResolverCache.delete(oldest);
+}
+
+function cacheGet(key: string): TokenProgramInfo | undefined {
+  const value = tokenProgramResolverCache.get(key);
+  if (!value) return undefined;
+  tokenProgramResolverCache.delete(key);
+  tokenProgramResolverCache.set(key, value);
+  return value;
+}
+
+export function tokenProgramInfoFromMintOwner(mintPubkey: PublicKey, owner: PublicKey): TokenProgramInfo {
+  if (owner.equals(TOKEN_PROGRAM_ID)) {
+    return {
+      tokenProgramId: TOKEN_PROGRAM_ID,
+      isToken2022: false,
+      mintPubkey,
+    };
+  }
+  if (owner.equals(TOKEN_2022_PROGRAM_ID)) {
+    return {
+      tokenProgramId: TOKEN_2022_PROGRAM_ID,
+      isToken2022: true,
+      mintPubkey,
+    };
+  }
+  fail('UNSUPPORTED_MINT_OWNER', 'Mint account owner is not a supported SPL token program', false, {
+    mint: mintPubkey.toBase58(),
+    owner: owner.toBase58(),
+    supportedOwners: [TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()],
+  });
+}
+
+export async function resolveTokenProgramForMint(connection: ReadonlyConnection, mintPubkey: PublicKey): Promise<TokenProgramInfo> {
+  const cacheKey = mintPubkey.toBase58();
+  const cached = cacheGet(cacheKey);
+  if (cached) return cached;
+
+  const mintAccount = await connection.getAccountInfo(mintPubkey, 'confirmed');
+  if (!mintAccount) {
+    fail('DATA_UNAVAILABLE', 'mint account unavailable', false, { mint: cacheKey });
+  }
+
+  const info = tokenProgramInfoFromMintOwner(mintPubkey, mintAccount.owner);
+  cacheSet(cacheKey, info);
+  return info;
+}
+
+export function __clearTokenProgramResolverCacheForTests(): void {
+  tokenProgramResolverCache.clear();
+}
+
+export function __tokenProgramResolverCacheSizeForTests(): number {
+  return tokenProgramResolverCache.size;
+}
diff --git a/packages/solana/src/token/whirlpool.ts b/packages/solana/src/token/whirlpool.ts
new file mode 100644
index 0000000..7603706
--- /dev/null
+++ b/packages/solana/src/token/whirlpool.ts
@@ -0,0 +1,39 @@
+import { PublicKey } from '@solana/web3.js';
+import { TOKEN_2022_PROGRAM_ID } from './constants';
+
+export type TokenContext = {
+  mintA: PublicKey;
+  mintB: PublicKey;
+  tokenProgramA: PublicKey;
+  tokenProgramB: PublicKey;
+  isToken2022A: boolean;
+  isToken2022B: boolean;
+};
+
+export type WhirlpoolInstructionVariant = 'v1' | 'v2';
+
+export const INCLUDE_MEMO_ON_V2 = true;
+
+export function isToken2022Program(tokenProgramId: PublicKey): boolean {
+  return tokenProgramId.equals(TOKEN_2022_PROGRAM_ID);
+}
+
+export function buildTokenContext(input: {
+  mintA: PublicKey;
+  mintB: PublicKey;
+  tokenProgramA: PublicKey;
+  tokenProgramB: PublicKey;
+}): TokenContext {
+  return {
+    mintA: input.mintA,
+    mintB: input.mintB,
+    tokenProgramA: input.tokenProgramA,
+    tokenProgramB: input.tokenProgramB,
+    isToken2022A: isToken2022Program(input.tokenProgramA),
+    isToken2022B: isToken2022Program(input.tokenProgramB),
+  };
+}
+
+export function selectWhirlpoolInstructionVariant(tokenContext: TokenContext): WhirlpoolInstructionVariant {
+  return tokenContext.isToken2022A || tokenContext.isToken2022B ? 'v2' : 'v1';
+}
diff --git a/packages/solana/src/types.ts b/packages/solana/src/types.ts
index 7ae545c..be6165d 100644
--- a/packages/solana/src/types.ts
+++ b/packages/solana/src/types.ts
@@ -1,5 +1,6 @@
 export type CanonicalErrorCode =
   | 'DATA_UNAVAILABLE'
+  | 'UNSUPPORTED_MINT_OWNER'
   | 'RPC_TRANSIENT'
   | 'RPC_PERMANENT'
   | 'INVALID_POSITION'
diff --git a/packages/solana/src/wsol.ts b/packages/solana/src/wsol.ts
index 0fa1a81..1b76c02 100644
--- a/packages/solana/src/wsol.ts
+++ b/packages/solana/src/wsol.ts
@@ -1,6 +1,7 @@
 import { PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js';
-import { TOKEN_PROGRAM_ID, createCloseAccountInstruction, createSyncNativeInstruction } from '@solana/spl-token';
-import { buildCreateAtaIdempotentIx, getAta, SOL_MINT } from './ata';
+import { createCloseAccountInstruction, createSyncNativeInstruction } from '@solana/spl-token';
+import { getAta, SOL_MINT } from './ata';
+import { TOKEN_PROGRAM_ID } from './token/constants';
 
 export type WsolLifecycle = {
   preSwap: TransactionInstruction[];
@@ -23,9 +24,7 @@ export function buildWsolLifecycleIxs(params: {
     return { preSwap: [], postSwap: [], wsolAta };
   }
 
-  const createAta = buildCreateAtaIdempotentIx({ payer: params.payer, owner: params.authority, mint: SOL_MINT, tokenProgramId: TOKEN_PROGRAM_ID }).ix;
-
-  const preSwap: TransactionInstruction[] = [createAta];
+  const preSwap: TransactionInstruction[] = [];
   const postSwap: TransactionInstruction[] = [];
 
   if (params.inputMint.equals(SOL_MINT)) {
diff --git a/specs/m16-token2022-first-class.spec.md b/specs/m16-token2022-first-class.spec.md
new file mode 100644
index 0000000..dec4812
--- /dev/null
+++ b/specs/m16-token2022-first-class.spec.md
@@ -0,0 +1,144 @@
+# M16 — Token-2022 first-class support (ATAs + Whirlpool v2 + test matrix)
+
+## Goal
+Make Token-2022 handling a first-class, deterministic capability across the codebase so devnet/mainnet execution works for pools and mints using SPL Token Extensions. This includes correct token-program resolution per mint, correct ATA creation/lookup, correct Orca Whirlpool instruction variants (v2) when Token-2022 is involved, and a minimum compatibility test matrix.
+
+## Non-goals
+- Supporting every Token-2022 extension feature (transfer hooks, confidential transfers, etc.) beyond what Orca Whirlpool requires.
+- Implementing a generic token-framework or “any token on Solana” abstraction.
+- Refactoring all token utilities unrelated to execution/swap/receipt paths.
+
+## Scope
+
+### In scope
+1) Universal token program resolution for each mint (Token vs Token-2022).
+2) ATA creation/lookup updated to use correct token program id per mint.
+3) Orca Whirlpool instruction variant selection:
+   - Use a single canonical path that is valid for all token-program combinations (recommended: Whirlpool v2 everywhere).
+   - If dual-path is retained (v1 + v2), document why and add explicit tests for both branches.
+4) Memo program handling when required by Whirlpool v2 paths.
+5) Minimum test matrix across all token-program combinations.
+
+### Out of scope
+- Adding new supported pairs beyond current MVP guardrails.
+- Handling non-ATA token accounts (custom token accounts) beyond reading balances if needed.
+- Building a new swap router; this milestone targets correctness of token plumbing.
+
+## Requirements
+
+## A) Token program resolution (authoritative, reusable)
+Add a single authoritative resolver in `packages/solana` (or `packages/core` if you already keep chain constants there):
+
+### API
+`resolveTokenProgramForMint(connection, mintPubkey) -> TokenProgramInfo`
+
+`TokenProgramInfo` must include:
+- `tokenProgramId` (either SPL Token program id or SPL Token-2022 program id)
+- `isToken2022: boolean`
+- `mintPubkey`
+
+### Rules
+- Resolver must be based on on-chain mint account owner:
+  - owner == `TOKEN_PROGRAM_ID` -> Token (spl-token)
+  - owner == `TOKEN_2022_PROGRAM_ID` -> Token-2022
+- If mint owner is neither, return a canonical error (e.g., `UNSUPPORTED_MINT_OWNER`).
+- Cache results in-memory per process run to avoid repeated RPC calls (must be safe and bounded).
+
+### Deliverable locations
+- `packages/solana/src/token/program.ts` (or equivalent)
+- Central constants for:
+  - `TOKEN_PROGRAM_ID`
+  - `TOKEN_2022_PROGRAM_ID`
+  - `ASSOCIATED_TOKEN_PROGRAM_ID`
+  - `MEMO_PROGRAM_ID` (if needed by Whirlpool v2 paths)
+
+## B) ATA create/resolve must be token-program aware
+Everywhere the builder or adapters create/resolve token accounts:
+
+### Requirements
+- Derive ATA address using the correct token program id for the mint.
+- Create ATA instructions must specify:
+  - associated token program id
+  - token program id (Token vs Token-2022)
+  - mint, owner, payer
+- Never assume USDC is always Token (spl-token). Always resolve based on mint owner.
+
+### Deliverables
+- A single function:
+  - `getOrCreateAtaIxs({ payer, owner, mint, tokenProgramId }) -> { ata, ixs[] }`
+- Refactor all callsites in:
+  - execution builder (exit tx)
+  - swap adapters (Jupiter/orca/noop as applicable)
+  - any SOL/WSOL lifecycle code (if WSOL ATA creation exists)
+
+### Invariants
+- No code path may use a hardcoded token program id when the mint program can differ.
+- Any ATA creation must be conditional (only if missing), consistent with current builder patterns.
+
+## C) Orca Whirlpool instruction variants (v2 when Token-2022 involved)
+Update Orca Whirlpool instruction construction to select the correct variant:
+
+### Variant selection rule (canonical)
+- Default requirement: use Whirlpool v2 instruction paths and supply required extra accounts for all supported pools:
+  - token program ids for both sides
+  - mint accounts for both sides
+  - memo program id where required
+- Optional dual-path mode (only if intentionally kept):
+  - v1 may be used for token/token pools
+  - v2 must be used whenever either side is Token-2022
+  - include explicit tests proving correct branch selection
+
+### Required behavior
+- All Whirlpool-related instructions in the live execution path must be Token-2022 compatible:
+  - remove liquidity
+  - collect fees/rewards
+  - swaps (if OrcaWhirlpoolSwapAdapter is used)
+- Instruction builders must accept a `TokenContext` object that includes:
+  - `tokenProgramA`, `tokenProgramB`
+  - `mintA`, `mintB`
+  - `isToken2022A`, `isToken2022B`
+
+### Deliverables
+- Centralized Whirlpool ix builder module updated to:
+  - resolve token programs for mintA/mintB once per build
+  - pick v1/v2 instruction variant
+  - include memo program account where required
+- Remove any brittle “works on token-only” assumptions.
+
+## D) Tests: minimum compatibility matrix
+Add unit/integration tests covering these token-program combinations:
+
+1) token/token (both spl-token)
+2) token2022/token
+3) token/token2022
+4) token2022/token2022
+
+### Test requirements
+- Tests must validate:
+  - resolver returns correct token program ids from mocked mint owners
+  - ATA derivation uses correct token program id
+  - requirements computation for swap quote input/output ATAs uses the resolved token program per mint (no implicit `TOKEN_PROGRAM_ID` default)
+  - Whirlpool ix builder chooses v1 vs v2 correctly
+  - v2 instruction builders include required extra accounts (token programs, mint accounts, memo when required)
+
+### Implementation guidance
+- Unit tests: mock mint account owner to simulate token/token2022 without requiring chain state.
+- Integration-ish tests: build a transaction message and assert:
+  - accounts list includes expected program ids and mints
+  - instruction data discriminators correspond to v1 vs v2 builders (as applicable)
+- If you have a devnet harness:
+  - add at least one devnet scenario exercising a Token-2022 pool (if available and stable), but do not block CI on devnet flakiness unless you already accept that.
+
+## Deliverables
+- Token program resolver + cache
+- Token-program-aware ATA utilities
+- Whirlpool instruction builders updated for v2 when Token-2022 involved (including memo handling)
+- Updated execution builder and swap adapters to use resolver + ATA utilities
+- Test suite implementing the 4-case matrix
+
+## Acceptance criteria (Definition of Done)
+- No hardcoded assumptions that USDC (or any mint) uses spl-token; token program is always resolved from chain/mocks.
+- `computeExecutionRequirements` (or equivalent requirements module) derives quote input/output ATAs with the correct token program per mint; no default-to-`TOKEN_PROGRAM_ID` for unknown quote mints.
+- Builder can construct valid instruction sets for any of the 4 matrix cases without missing required accounts.
+- Unit tests cover resolver + ATA derivation + v1/v2 selection and pass reliably.
+- Execution path is Token-2022 compatible for remove/collect/swap, with memo program included when required by v2 instructions.
```
