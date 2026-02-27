# Review Pack

## Branch / Base
- HEAD: manual-testing @ 4425365
- Base: origin/main @ 8b27b99
- Merge-base: 97bdb3408539381f7c745f5fe397d518c8fc3480 @ 97bdb34

## Recent commits
4425365 (HEAD -> manual-testing, origin/manual-testing) orca remove liquidity working version
084f720 add wallet connected message and pool in range
12bc59f update usdc devnet mint
718af91 fix orca position parsing

## Diff stat
 apps/mobile/App.tsx                                | 153 ++++++++++++++++++-
 apps/web/src/app/page.tsx                          | 169 ++++++++++++++++++++-
 packages/core/src/mints.ts                         |   2 +-
 packages/core/src/swapDecision.ts                  |  10 ++
 packages/notifications/src/index.ts                |  10 +-
 .../solana/src/__tests__/orcaInspector.spec.ts     |   5 +-
 packages/solana/src/errors.ts                      |  32 +++-
 packages/solana/src/executeOnce.ts                 |  84 ++++++----
 packages/solana/src/executionBuilder.ts            |  20 +--
 packages/solana/src/jupiter.ts                     |  19 +++
 packages/solana/src/orcaExitBuilder.ts             |  31 +++-
 packages/solana/src/orcaInspector.ts               |  52 ++++++-
 packages/solana/src/receipt.ts                     |   1 +
 packages/solana/src/requirements.ts                |   4 +-
 14 files changed, 523 insertions(+), 69 deletions(-)

## Full PR diff
```diff
diff --git a/apps/mobile/App.tsx b/apps/mobile/App.tsx
index ac1ec1f..8745392 100644
--- a/apps/mobile/App.tsx
+++ b/apps/mobile/App.tsx
@@ -23,6 +23,58 @@ const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
 
 type Sample = { slot: number; unixTs: number; currentTickIndex: number };
 
+function latestPolicySample(samples: readonly Sample[]): Sample | undefined {
+  let latest: Sample | undefined;
+  for (const sample of samples) {
+    if (
+      !latest ||
+      sample.slot > latest.slot ||
+      (sample.slot === latest.slot && sample.unixTs > latest.unixTs)
+    ) {
+      latest = sample;
+    }
+  }
+  return latest;
+}
+
+function toPreviewPolicyState(args: {
+  currentPreview: PolicyState;
+  executionState: PolicyState;
+  evaluatedSample?: Sample;
+}): PolicyState {
+  return {
+    lastTriggerUnixTs: args.executionState.lastTriggerUnixTs,
+    lastEvaluatedSample: args.evaluatedSample ?? args.currentPreview.lastEvaluatedSample,
+  };
+}
+
+function commitExecutionPolicyStateFromExecuteResult(args: {
+  currentExecution: PolicyState;
+  status: 'HOLD' | 'EXECUTED' | 'ERROR';
+  latestSample?: Sample;
+}): PolicyState {
+  if (args.status === 'EXECUTED') {
+    return {
+      lastTriggerUnixTs: args.latestSample?.unixTs ?? args.currentExecution.lastTriggerUnixTs,
+      lastEvaluatedSample: args.latestSample ?? args.currentExecution.lastEvaluatedSample,
+    };
+  }
+  if (args.status === 'HOLD') {
+    return {
+      lastTriggerUnixTs: args.currentExecution.lastTriggerUnixTs,
+      lastEvaluatedSample: args.latestSample ?? args.currentExecution.lastEvaluatedSample,
+    };
+  }
+  return args.currentExecution;
+}
+
+function syncPreviewStateAfterExecute(previewState: PolicyState, executionState: PolicyState): PolicyState {
+  return {
+    lastTriggerUnixTs: executionState.lastTriggerUnixTs,
+    lastEvaluatedSample: executionState.lastEvaluatedSample ?? previewState.lastEvaluatedSample,
+  };
+}
+
 export default function App() {
   const notifications = useMemo(() => createConsoleNotificationsAdapter(), []);
   const loaded = useMemo(() => loadAutopilotConfig(), []);
@@ -33,7 +85,8 @@ export default function App() {
   const [ui, setUi] = useState<UiModel>(buildUiModel({}));
   const [simSummary, setSimSummary] = useState('N/A');
   const [samples, setSamples] = useState<Sample[]>([]);
-  const policyStateRef = useRef<PolicyState>({});
+  const previewPolicyStateRef = useRef<PolicyState>({});
+  const executionPolicyStateRef = useRef<PolicyState>({});
   const [attestationDebugPrefix, setAttestationDebugPrefix] = useState('N/A');
   const [swapPlanSummary, setSwapPlanSummary] = useState('N/A');
   const monitorRef = useRef<ReturnType<typeof setInterval> | null>(null);
@@ -48,6 +101,8 @@ export default function App() {
       monitorRef.current = null;
     }
     setSamples([]);
+    previewPolicyStateRef.current = {};
+    executionPolicyStateRef.current = {};
 
     if (!positionAddress) return;
 
@@ -100,6 +155,9 @@ export default function App() {
           title={wallet ? 'Wallet Connected' : 'Connect Wallet'}
           onPress={async () => setWallet((await runMwaSignMessageSmoke()).publicKey)}
         />
+        <Text style={{ fontSize: 12, color: '#374151' }}>
+          wallet: {wallet ? `${wallet.slice(0, 4)}...${wallet.slice(-4)} (${wallet})` : 'not connected'}
+        </Text>
 
         <TextInput
           placeholder="Orca position account"
@@ -124,11 +182,15 @@ export default function App() {
                 position: new PublicKey(positionAddress),
                 samples: nextSamples,
                 config: autopilotConfig,
-                policyState: policyStateRef.current,
+                policyState: previewPolicyStateRef.current,
                 expectedMinOut: 'N/A',
                 quoteAgeMs: 0,
               });
-              policyStateRef.current = r.decision.nextState;
+              previewPolicyStateRef.current = toPreviewPolicyState({
+                currentPreview: previewPolicyStateRef.current,
+                executionState: executionPolicyStateRef.current,
+                evaluatedSample: latestPolicySample(nextSamples),
+              });
               setUi(buildUiModel({
                 config: {
                   policy: autopilotConfig.policy,
@@ -240,15 +302,97 @@ export default function App() {
                 samples,
                 quote,
                 config: autopilotConfig,
-                policyState: policyStateRef.current,
+                policyState: executionPolicyStateRef.current,
                 expectedMinOut: quote.outAmount.toString(),
                 quoteAgeMs: Math.max(0, Date.now() - quote.quotedAtUnixMs),
                 attestationHash,
                 attestationPayloadBytes,
+                rebuildSnapshotAndQuote: async () => {
+                  const rebuiltSnapshot = await loadPositionSnapshot(connection, position, autopilotConfig.cluster);
+                  if (!rebuiltSnapshot.removePreview) {
+                    throw new Error(`Remove preview unavailable (${rebuiltSnapshot.removePreviewReasonCode ?? 'DATA_UNAVAILABLE'})`);
+                  }
+
+                  const rebuiltTokenAOut = rebuiltSnapshot.removePreview.tokenAOut;
+                  const rebuiltTokenBOut = rebuiltSnapshot.removePreview.tokenBOut;
+                  const rebuiltInputMint = dir === 'DOWN'
+                    ? SOL_MINT
+                    : (rebuiltSnapshot.tokenMintA.equals(SOL_MINT) ? rebuiltSnapshot.tokenMintB : rebuiltSnapshot.tokenMintA);
+                  const rebuiltOutputMint = dir === 'DOWN'
+                    ? (rebuiltSnapshot.tokenMintA.equals(SOL_MINT) ? rebuiltSnapshot.tokenMintB : rebuiltSnapshot.tokenMintA)
+                    : SOL_MINT;
+                  const rebuiltAmount = dir === 'DOWN'
+                    ? (rebuiltSnapshot.tokenMintA.equals(SOL_MINT) ? rebuiltTokenAOut : rebuiltTokenBOut)
+                    : (rebuiltSnapshot.tokenMintA.equals(SOL_MINT) ? rebuiltTokenBOut : rebuiltTokenAOut);
+                  const rebuiltSwapDecision = decideSwap(rebuiltAmount, dir, autopilotConfig);
+                  const rebuiltQuote = rebuiltSwapDecision.execute
+                    ? await fetchJupiterQuote({
+                        inputMint: rebuiltInputMint,
+                        outputMint: rebuiltOutputMint,
+                        amount: rebuiltAmount,
+                        slippageBps: autopilotConfig.execution.slippageBpsCap,
+                      })
+                    : {
+                        inputMint: rebuiltInputMint,
+                        outputMint: rebuiltOutputMint,
+                        inAmount: rebuiltAmount,
+                        outAmount: 0n,
+                        slippageBps: autopilotConfig.execution.slippageBpsCap,
+                        quotedAtUnixMs: Date.now(),
+                      };
+
+                  const rebuiltAttestationInput = {
+                    cluster: autopilotConfig.cluster,
+                    authority: authority.toBase58(),
+                    position: rebuiltSnapshot.position.toBase58(),
+                    positionMint: rebuiltSnapshot.positionMint.toBase58(),
+                    whirlpool: rebuiltSnapshot.whirlpool.toBase58(),
+                    epoch,
+                    direction: dir === 'UP' ? (1 as const) : (0 as const),
+                    tickCurrent: rebuiltSnapshot.currentTickIndex,
+                    lowerTickIndex: rebuiltSnapshot.lowerTickIndex,
+                    upperTickIndex: rebuiltSnapshot.upperTickIndex,
+                    slippageBpsCap: autopilotConfig.execution.slippageBpsCap,
+                    quoteInputMint: rebuiltQuote.inputMint.toBase58(),
+                    quoteOutputMint: rebuiltQuote.outputMint.toBase58(),
+                    quoteInAmount: rebuiltQuote.inAmount,
+                    quoteMinOutAmount: rebuiltQuote.outAmount,
+                    quoteQuotedAtUnixMs: BigInt(rebuiltQuote.quotedAtUnixMs),
+                    swapPlanned: 1,
+                    swapExecuted: rebuiltSwapDecision.execute ? 1 : 0,
+                    swapReasonCode: rebuiltSwapDecision.reasonCode,
+                  };
+                  const rebuiltPayload = encodeAttestationPayload(rebuiltAttestationInput);
+                  const rebuiltHash = computeAttestationHash(rebuiltAttestationInput);
+                  if (rebuiltPayload.length !== attestationPayloadBytes.length) {
+                    throw new Error('Attestation payload length changed during quote rebuild');
+                  }
+                  if (rebuiltHash.length !== attestationHash.length) {
+                    throw new Error('Attestation hash length changed during quote rebuild');
+                  }
+                  attestationPayloadBytes.set(rebuiltPayload);
+                  attestationHash.set(rebuiltHash);
+                  setAttestationDebugPrefix(Buffer.from(attestationHash).toString('hex').slice(0, 12));
+
+                  return { snapshot: rebuiltSnapshot, quote: rebuiltQuote };
+                },
                 onSimulationComplete: (s) => setSimSummary(`${s} — ready for wallet prompt`),
                 signAndSend: async (tx: VersionedTransaction) => (await runMwaSignAndSendVersionedTransaction(tx)).signature,
                 logger: notifications,
               });
+              const executeLatestSample = latestPolicySample(samples);
+              executionPolicyStateRef.current = commitExecutionPolicyStateFromExecuteResult({
+                currentExecution: executionPolicyStateRef.current,
+                status: result.status,
+                latestSample: executeLatestSample,
+              });
+              previewPolicyStateRef.current = syncPreviewStateAfterExecute(
+                previewPolicyStateRef.current,
+                executionPolicyStateRef.current,
+              );
+              if (result.status === 'HOLD') {
+                setSimSummary(`Skipped before simulation: ${result.refresh?.decision?.reasonCode ?? 'HOLD'}`);
+              }
 
               setUi(
                 buildUiModel({
@@ -282,6 +426,7 @@ export default function App() {
         <Text>current tick: {ui.snapshot?.currentTick ?? 'N/A'}</Text>
         <Text>lower tick: {ui.snapshot?.lowerTick ?? 'N/A'}</Text>
         <Text>upper tick: {ui.snapshot?.upperTick ?? 'N/A'}</Text>
+        <Text>pool in range: {ui.snapshot?.inRange === undefined ? 'N/A' : ui.snapshot.inRange ? 'yes' : 'no'}</Text>
         <Text>decision: {ui.decision?.decision ?? 'N/A'}</Text>
         <Text>reasonCode: {ui.decision?.reasonCode ?? 'N/A'}</Text>
         <Text>debounce progress: {ui.decision ? `${ui.decision.samplesUsed}/${ui.decision.threshold}` : 'N/A'}</Text>
diff --git a/apps/web/src/app/page.tsx b/apps/web/src/app/page.tsx
index d3e258c..f79a2b6 100644
--- a/apps/web/src/app/page.tsx
+++ b/apps/web/src/app/page.tsx
@@ -20,11 +20,64 @@ import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
 type WalletProvider = {
   connect: () => Promise<void>;
   publicKey?: { toBase58: () => string };
+  signTransaction?: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
   signAndSendTransaction: (tx: VersionedTransaction) => Promise<{ signature: string }>;
 };
 
 type Sample = { slot: number; unixTs: number; currentTickIndex: number };
 
+function latestPolicySample(samples: readonly Sample[]): Sample | undefined {
+  let latest: Sample | undefined;
+  for (const sample of samples) {
+    if (
+      !latest ||
+      sample.slot > latest.slot ||
+      (sample.slot === latest.slot && sample.unixTs > latest.unixTs)
+    ) {
+      latest = sample;
+    }
+  }
+  return latest;
+}
+
+function toPreviewPolicyState(args: {
+  currentPreview: PolicyState;
+  executionState: PolicyState;
+  evaluatedSample?: Sample;
+}): PolicyState {
+  return {
+    lastTriggerUnixTs: args.executionState.lastTriggerUnixTs,
+    lastEvaluatedSample: args.evaluatedSample ?? args.currentPreview.lastEvaluatedSample,
+  };
+}
+
+function commitExecutionPolicyStateFromExecuteResult(args: {
+  currentExecution: PolicyState;
+  status: 'HOLD' | 'EXECUTED' | 'ERROR';
+  latestSample?: Sample;
+}): PolicyState {
+  if (args.status === 'EXECUTED') {
+    return {
+      lastTriggerUnixTs: args.latestSample?.unixTs ?? args.currentExecution.lastTriggerUnixTs,
+      lastEvaluatedSample: args.latestSample ?? args.currentExecution.lastEvaluatedSample,
+    };
+  }
+  if (args.status === 'HOLD') {
+    return {
+      lastTriggerUnixTs: args.currentExecution.lastTriggerUnixTs,
+      lastEvaluatedSample: args.latestSample ?? args.currentExecution.lastEvaluatedSample,
+    };
+  }
+  return args.currentExecution;
+}
+
+function syncPreviewStateAfterExecute(previewState: PolicyState, executionState: PolicyState): PolicyState {
+  return {
+    lastTriggerUnixTs: executionState.lastTriggerUnixTs,
+    lastEvaluatedSample: executionState.lastEvaluatedSample ?? previewState.lastEvaluatedSample,
+  };
+}
+
 export default function Home() {
   const solanaConfig = loadSolanaConfig(process.env);
   const loaded = useMemo(() => loadAutopilotConfig(process.env), []);
@@ -36,7 +89,8 @@ export default function Home() {
   const [ui, setUi] = useState<UiModel>(buildUiModel({}));
   const [simSummary, setSimSummary] = useState<string>('N/A');
   const [samples, setSamples] = useState<Sample[]>([]);
-  const policyStateRef = useRef<PolicyState>({});
+  const previewPolicyStateRef = useRef<PolicyState>({});
+  const executionPolicyStateRef = useRef<PolicyState>({});
   const [lastSimDebug, setLastSimDebug] = useState<unknown>(null);
   const [attestationDebugPrefix, setAttestationDebugPrefix] = useState<string>('N/A');
   const [swapPlanSummary, setSwapPlanSummary] = useState<string>('N/A');
@@ -50,6 +104,8 @@ export default function Home() {
       pollingRef.current = null;
     }
     setSamples([]);
+    previewPolicyStateRef.current = {};
+    executionPolicyStateRef.current = {};
 
     if (!positionAddress) return;
 
@@ -124,6 +180,9 @@ export default function Home() {
           Disconnect
         </button>
       </div>
+      <div className="text-sm text-gray-700">
+        wallet: {wallet ? `${wallet.slice(0, 4)}...${wallet.slice(-4)} (${wallet})` : 'not connected'}
+      </div>
 
       <input
         className="border rounded px-3 py-2 w-full"
@@ -144,11 +203,15 @@ export default function Home() {
                 position: new PublicKey(positionAddress),
                 samples,
                 config: autopilotConfig,
-                policyState: policyStateRef.current,
+                policyState: previewPolicyStateRef.current,
                 expectedMinOut: 'N/A',
                 quoteAgeMs: 0,
               });
-              policyStateRef.current = refreshed.decision.nextState;
+              previewPolicyStateRef.current = toPreviewPolicyState({
+                currentPreview: previewPolicyStateRef.current,
+                executionState: executionPolicyStateRef.current,
+                evaluatedSample: latestPolicySample(samples),
+              });
               setUi(buildUiModel({
                 config: {
                   policy: autopilotConfig.policy,
@@ -270,17 +333,108 @@ export default function Home() {
                 samples,
                 quote,
                 config: autopilotConfig,
-                policyState: policyStateRef.current,
+                policyState: executionPolicyStateRef.current,
                 expectedMinOut: quote.outAmount.toString(),
                 quoteAgeMs: Math.max(0, Date.now() - quote.quotedAtUnixMs),
                 attestationHash,
                 attestationPayloadBytes,
+                rebuildSnapshotAndQuote: async () => {
+                  const rebuiltSnapshot = await loadPositionSnapshot(connection, position, autopilotConfig.cluster);
+                  if (!rebuiltSnapshot.removePreview) {
+                    throw new Error(`Remove preview unavailable (${rebuiltSnapshot.removePreviewReasonCode ?? 'DATA_UNAVAILABLE'})`);
+                  }
+
+                  const rebuiltTokenAOut = rebuiltSnapshot.removePreview.tokenAOut;
+                  const rebuiltTokenBOut = rebuiltSnapshot.removePreview.tokenBOut;
+                  const rebuiltInputMint = dir === 'DOWN'
+                    ? SOL_MINT
+                    : (rebuiltSnapshot.tokenMintA.equals(SOL_MINT) ? rebuiltSnapshot.tokenMintB : rebuiltSnapshot.tokenMintA);
+                  const rebuiltOutputMint = dir === 'DOWN'
+                    ? (rebuiltSnapshot.tokenMintA.equals(SOL_MINT) ? rebuiltSnapshot.tokenMintB : rebuiltSnapshot.tokenMintA)
+                    : SOL_MINT;
+                  const rebuiltAmount = dir === 'DOWN'
+                    ? (rebuiltSnapshot.tokenMintA.equals(SOL_MINT) ? rebuiltTokenAOut : rebuiltTokenBOut)
+                    : (rebuiltSnapshot.tokenMintA.equals(SOL_MINT) ? rebuiltTokenBOut : rebuiltTokenAOut);
+                  const rebuiltSwapDecision = decideSwap(rebuiltAmount, dir, autopilotConfig);
+                  const rebuiltQuote = rebuiltSwapDecision.execute
+                    ? await fetchJupiterQuote({
+                        inputMint: rebuiltInputMint,
+                        outputMint: rebuiltOutputMint,
+                        amount: rebuiltAmount,
+                        slippageBps: autopilotConfig.execution.slippageBpsCap,
+                      })
+                    : {
+                        inputMint: rebuiltInputMint,
+                        outputMint: rebuiltOutputMint,
+                        inAmount: rebuiltAmount,
+                        outAmount: BigInt(0),
+                        slippageBps: autopilotConfig.execution.slippageBpsCap,
+                        quotedAtUnixMs: Date.now(),
+                      };
+
+                  const rebuiltAttestationInput = {
+                    cluster: autopilotConfig.cluster,
+                    authority: authority.toBase58(),
+                    position: rebuiltSnapshot.position.toBase58(),
+                    positionMint: rebuiltSnapshot.positionMint.toBase58(),
+                    whirlpool: rebuiltSnapshot.whirlpool.toBase58(),
+                    epoch,
+                    direction: dir === 'UP' ? (1 as const) : (0 as const),
+                    tickCurrent: rebuiltSnapshot.currentTickIndex,
+                    lowerTickIndex: rebuiltSnapshot.lowerTickIndex,
+                    upperTickIndex: rebuiltSnapshot.upperTickIndex,
+                    slippageBpsCap: autopilotConfig.execution.slippageBpsCap,
+                    quoteInputMint: rebuiltQuote.inputMint.toBase58(),
+                    quoteOutputMint: rebuiltQuote.outputMint.toBase58(),
+                    quoteInAmount: rebuiltQuote.inAmount,
+                    quoteMinOutAmount: rebuiltQuote.outAmount,
+                    quoteQuotedAtUnixMs: BigInt(rebuiltQuote.quotedAtUnixMs),
+                    swapPlanned: 1,
+                    swapExecuted: rebuiltSwapDecision.execute ? 1 : 0,
+                    swapReasonCode: rebuiltSwapDecision.reasonCode,
+                  };
+                  const rebuiltPayload = encodeAttestationPayload(rebuiltAttestationInput);
+                  const rebuiltHash = computeAttestationHash(rebuiltAttestationInput);
+                  if (rebuiltPayload.length !== attestationPayloadBytes.length) {
+                    throw new Error('Attestation payload length changed during quote rebuild');
+                  }
+                  if (rebuiltHash.length !== attestationHash.length) {
+                    throw new Error('Attestation hash length changed during quote rebuild');
+                  }
+                  attestationPayloadBytes.set(rebuiltPayload);
+                  attestationHash.set(rebuiltHash);
+                  setAttestationDebugPrefix(Buffer.from(attestationHash).toString('hex').slice(0, 12));
+
+                  return { snapshot: rebuiltSnapshot, quote: rebuiltQuote };
+                },
                 onSimulationComplete: (s) => setSimSummary(`${s} — ready for wallet prompt`),
-                signAndSend: async (tx: VersionedTransaction) => (await provider.signAndSendTransaction(tx)).signature,
+                signAndSend: async (tx: VersionedTransaction) => {
+                  if (provider.signTransaction) {
+                    notifications.notify('requesting wallet signature');
+                    const signed = await provider.signTransaction(tx);
+                    notifications.notify('wallet signature ok');
+                    const sig = await connection.sendRawTransaction(signed.serialize(), {
+                      preflightCommitment: solanaConfig.commitment,
+                    });
+                    notifications.notify('rpc send ok', { sig });
+                    return sig;
+                  }
+                  return (await provider.signAndSendTransaction(tx)).signature;
+                },
                 logger: notifications,
               });
-              if (res.refresh?.decision?.nextState) {
-                policyStateRef.current = res.refresh.decision.nextState;
+              const executeLatestSample = latestPolicySample(samples);
+              executionPolicyStateRef.current = commitExecutionPolicyStateFromExecuteResult({
+                currentExecution: executionPolicyStateRef.current,
+                status: res.status,
+                latestSample: executeLatestSample,
+              });
+              previewPolicyStateRef.current = syncPreviewStateAfterExecute(
+                previewPolicyStateRef.current,
+                executionPolicyStateRef.current,
+              );
+              if (res.status === 'HOLD') {
+                setSimSummary(`Skipped before simulation: ${res.refresh?.decision?.reasonCode ?? 'HOLD'}`);
               }
 
               setLastSimDebug(res.errorDebug ?? null);
@@ -320,6 +474,7 @@ export default function Home() {
         <div>current tick: {ui.snapshot?.currentTick ?? 'N/A'}</div>
         <div>lower tick: {ui.snapshot?.lowerTick ?? 'N/A'}</div>
         <div>upper tick: {ui.snapshot?.upperTick ?? 'N/A'}</div>
+        <div>pool in range: {ui.snapshot?.inRange === undefined ? 'N/A' : ui.snapshot.inRange ? 'yes' : 'no'}</div>
         <div>decision: {ui.decision?.decision ?? 'N/A'}</div>
         <div>reasonCode: {ui.decision?.reasonCode ?? 'N/A'}</div>
         <div>debounce progress: {ui.decision ? `${ui.decision.samplesUsed}/${ui.decision.threshold}` : 'N/A'}</div>
diff --git a/packages/core/src/mints.ts b/packages/core/src/mints.ts
index f82eb3a..fdbb16d 100644
--- a/packages/core/src/mints.ts
+++ b/packages/core/src/mints.ts
@@ -8,7 +8,7 @@ export type CanonicalPairError = Error & {
 
 const SOL_NATIVE_MARKER = 'SOL_NATIVE';
 const WSOL_MINT = 'So11111111111111111111111111111111111111112';
-const USDC_DEVNET_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
+const USDC_DEVNET_MINT = 'BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k';
 const USDC_MAINNET_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
 
 export type MintRegistry = {
diff --git a/packages/core/src/swapDecision.ts b/packages/core/src/swapDecision.ts
index a2a00eb..702fd4e 100644
--- a/packages/core/src/swapDecision.ts
+++ b/packages/core/src/swapDecision.ts
@@ -3,6 +3,7 @@ import type { AutopilotConfig } from './config';
 export const SWAP_OK = 0;
 export const SWAP_SKIP_DUST_SOL = 1;
 export const SWAP_SKIP_DUST_USDC = 2;
+const DISABLE_SWAP_BRANCH_FOR_TESTING = true;
 
 export type SwapReasonCode = typeof SWAP_OK | typeof SWAP_SKIP_DUST_SOL | typeof SWAP_SKIP_DUST_USDC;
 
@@ -16,6 +17,15 @@ export function decideSwap(
   direction: 'DOWN' | 'UP',
   config: { execution: Pick<AutopilotConfig['execution'], 'minSolLamportsToSwap' | 'minUsdcMinorToSwap'> },
 ): SwapDecision {
+  if (DISABLE_SWAP_BRANCH_FOR_TESTING) {
+    // Temporary test-mode bypass: skip the entire swap path (Jupiter + WSOL + swap ATAs)
+    // while preserving a valid no-swap reason code shape for attestation/build validation.
+    return {
+      execute: false,
+      reasonCode: direction === 'DOWN' ? SWAP_SKIP_DUST_SOL : SWAP_SKIP_DUST_USDC,
+    };
+  }
+
   if (direction === 'DOWN') {
     if (exposure < BigInt(config.execution.minSolLamportsToSwap)) {
       return { execute: false, reasonCode: SWAP_SKIP_DUST_SOL };
diff --git a/packages/notifications/src/index.ts b/packages/notifications/src/index.ts
index ede89dd..002bd1b 100644
--- a/packages/notifications/src/index.ts
+++ b/packages/notifications/src/index.ts
@@ -7,11 +7,17 @@ export function createConsoleNotificationsAdapter(): NotificationsAdapter {
   return {
     notify(info, context) {
       // eslint-disable-next-line no-console
-      console.log(`[M6][INFO] ${info}`, context ?? {});
+      console.log(`[INFO] ${info}`, context ?? {});
     },
     notifyError(err, context) {
+      const message =
+        err instanceof Error
+          ? err.message
+          : (typeof err === 'object' && err && 'message' in err && typeof (err as { message?: unknown }).message === 'string')
+            ? ((err as { message: string }).message)
+            : String(err);
       // eslint-disable-next-line no-console
-      console.error(`[M6][ERROR] ${err instanceof Error ? err.message : String(err)}`, context ?? {});
+      console.error(`[ERROR] ${message}`, context ?? {}, err);
     },
   };
 }
diff --git a/packages/solana/src/__tests__/orcaInspector.spec.ts b/packages/solana/src/__tests__/orcaInspector.spec.ts
index da11f7e..b672d55 100644
--- a/packages/solana/src/__tests__/orcaInspector.spec.ts
+++ b/packages/solana/src/__tests__/orcaInspector.spec.ts
@@ -1,4 +1,5 @@
 import { afterEach, describe, expect, it } from 'vitest';
+import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
 import { Keypair, PublicKey } from '@solana/web3.js';
 import {
   __setRemovePreviewQuoteFnForTests,
@@ -6,8 +7,8 @@ import {
   loadPositionSnapshot,
 } from '../orcaInspector';
 
-const TOKEN_PROGRAM_V1 = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
-const TOKEN_PROGRAM_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkA6Ww2c47QhN7f6vYfP2D4W3');
+const TOKEN_PROGRAM_V1 = TOKEN_PROGRAM_ID;
+const TOKEN_PROGRAM_2022 = TOKEN_2022_PROGRAM_ID;
 const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
 const USDC_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
 
diff --git a/packages/solana/src/errors.ts b/packages/solana/src/errors.ts
index a7d9577..3b8c4a8 100644
--- a/packages/solana/src/errors.ts
+++ b/packages/solana/src/errors.ts
@@ -20,20 +20,42 @@ function isCanonicalCode(value: unknown): value is CanonicalErrorCode {
   return typeof value === 'string' && CANONICAL_CODES.includes(value as CanonicalErrorCode);
 }
 
+function safeJson(value: unknown): string | undefined {
+  try {
+    return JSON.stringify(value);
+  } catch {
+    return undefined;
+  }
+}
+
+function extractObjectMessage(error: unknown): string | undefined {
+  if (!error || typeof error !== 'object') return undefined;
+  const e = error as {
+    message?: unknown;
+    error?: { message?: unknown; data?: unknown };
+    data?: unknown;
+    code?: unknown;
+  };
+  if (typeof e.message === 'string' && e.message.trim()) return e.message;
+  if (e.error && typeof e.error.message === 'string' && e.error.message.trim()) return e.error.message;
+  const encoded = safeJson(error);
+  return encoded && encoded !== '{}' ? encoded : undefined;
+}
+
 export function normalizeSolanaError(error: unknown): NormalizedError {
   if (typeof error === 'object' && error) {
-    const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown };
+    const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown; debug?: unknown };
     if (isCanonicalCode(candidate.code)) {
       return {
         code: candidate.code,
         message: typeof candidate.message === 'string' ? candidate.message : String(candidate.code),
         retryable: typeof candidate.retryable === 'boolean' ? candidate.retryable : false,
-        debug: 'debug' in candidate ? (candidate as { debug?: unknown }).debug : undefined,
+        debug: 'debug' in candidate ? candidate.debug : undefined,
       };
     }
   }
 
-  const msg = error instanceof Error ? error.message : String(error ?? 'Unknown error');
+  const msg = error instanceof Error ? error.message : (extractObjectMessage(error) ?? String(error ?? 'Unknown error'));
   const lower = msg.toLowerCase();
 
   if (
@@ -53,8 +75,8 @@ export function normalizeSolanaError(error: unknown): NormalizedError {
   }
 
   if (transientHints.some((h) => lower.includes(h))) {
-    return { code: 'RPC_TRANSIENT', message: msg, retryable: true };
+    return { code: 'RPC_TRANSIENT', message: msg, retryable: true, debug: error };
   }
 
-  return { code: 'RPC_PERMANENT', message: msg, retryable: false };
+  return { code: 'RPC_PERMANENT', message: msg, retryable: false, debug: error };
 }
diff --git a/packages/solana/src/executeOnce.ts b/packages/solana/src/executeOnce.ts
index c69b271..293c37d 100644
--- a/packages/solana/src/executeOnce.ts
+++ b/packages/solana/src/executeOnce.ts
@@ -5,10 +5,12 @@ import { computeExecutionRequirements } from './requirements';
 import { fetchJupiterSwapIxs } from './jupiter';
 import { normalizeSolanaError } from './errors';
 import { loadPositionSnapshot } from './orcaInspector';
-import { deriveReceiptPda, fetchReceiptByPda } from './receipt';
+import { deriveReceiptPda, DISABLE_RECEIPT_PROGRAM_FOR_TESTING, fetchReceiptByPda } from './receipt';
 import { refreshBlockhashIfNeeded, shouldRebuild, withBoundedRetry } from './reliability';
 import type { CanonicalErrorCode } from './types';
 
+const SKIP_PREFLIGHT_SIMULATION_FOR_TESTING = true;
+
 type Logger = {
   notify?: (info: string, context?: Record<string, string | number | boolean>) => void;
   notifyError?: (err: unknown, context?: Record<string, string | number | boolean>) => void;
@@ -139,8 +141,11 @@ async function loadLookupTables(connection: Connection, addresses: PublicKey[]):
 export async function executeOnce(params: ExecuteOnceParams): Promise<ExecuteOnceResult> {
   const sleep = params.sleep ?? (async (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
   const nowUnixMs = params.nowUnixMs ?? (() => Date.now());
+  let stage = 'init';
+  let sentSig: string | undefined;
 
   try {
+    stage = 'refresh_position_decision';
     const refreshed = await withBoundedRetry(() => refreshPositionDecision(params), sleep, params.config.execution);
     params.logger?.notify?.('snapshot fetched', { position: params.position.toBase58() });
 
@@ -148,6 +153,7 @@ export async function executeOnce(params: ExecuteOnceParams): Promise<ExecuteOnc
       return { status: 'HOLD', refresh: refreshed };
     }
 
+    stage = 'load_snapshot';
     let snapshot = await withBoundedRetry(
       () => loadPositionSnapshot(params.connection, params.position, params.config.cluster),
       sleep,
@@ -156,6 +162,7 @@ export async function executeOnce(params: ExecuteOnceParams): Promise<ExecuteOnc
     let quote = params.quote;
     let quoteContext = params.quoteContext;
 
+    stage = 'get_slot';
     const latestSlot = await withBoundedRetry(() => params.connection.getSlot('confirmed'), sleep, params.config.execution);
 
     const rebuildCheck = shouldRebuild(
@@ -183,6 +190,7 @@ export async function executeOnce(params: ExecuteOnceParams): Promise<ExecuteOnc
           errorMessage: `Rebuild required: ${rebuildCheck.reasonCode}`,
         };
       }
+      stage = 'rebuild_snapshot_and_quote';
       const rebuilt = await withBoundedRetry(() => params.rebuildSnapshotAndQuote!(), sleep, params.config.execution);
       snapshot = rebuilt.snapshot;
       quote = rebuilt.quote;
@@ -192,19 +200,25 @@ export async function executeOnce(params: ExecuteOnceParams): Promise<ExecuteOnc
 
     const epochSourceMs = nowUnixMs();
     const epoch = unixDaysFromUnixMs(epochSourceMs);
-    const [receiptPda] = deriveReceiptPda({ authority: params.authority, positionMint: snapshot.positionMint, epoch });
-    const existingReceipt = params.checkExistingReceipt
-      ? await params.checkExistingReceipt(receiptPda)
-      : Boolean(await withBoundedRetry(() => fetchReceiptByPda(params.connection, receiptPda), sleep, params.config.execution));
-    if (existingReceipt) {
-      return {
-        status: 'ERROR',
-        refresh: refreshed,
-        errorCode: 'ALREADY_EXECUTED_THIS_EPOCH',
-        errorMessage: 'Execution receipt already exists for canonical epoch',
-      };
+    const receiptPda = DISABLE_RECEIPT_PROGRAM_FOR_TESTING
+      ? null
+      : deriveReceiptPda({ authority: params.authority, positionMint: snapshot.positionMint, epoch })[0];
+    if (!DISABLE_RECEIPT_PROGRAM_FOR_TESTING && receiptPda) {
+      stage = 'check_existing_receipt';
+      const existingReceipt = params.checkExistingReceipt
+        ? await params.checkExistingReceipt(receiptPda)
+        : Boolean(await withBoundedRetry(() => fetchReceiptByPda(params.connection, receiptPda), sleep, params.config.execution));
+      if (existingReceipt) {
+        return {
+          status: 'ERROR',
+          refresh: refreshed,
+          errorCode: 'ALREADY_EXECUTED_THIS_EPOCH',
+          errorMessage: 'Execution receipt already exists for canonical epoch',
+        };
+      }
     }
 
+    stage = 'get_balance';
     const availableLamports = await withBoundedRetry(
       () => params.connection.getBalance(params.authority),
       sleep,
@@ -212,6 +226,7 @@ export async function executeOnce(params: ExecuteOnceParams): Promise<ExecuteOnc
     );
 
     const fetchedAtUnixMs = nowUnixMs();
+    stage = 'get_latest_blockhash';
     let latestBlockhash = await withBoundedRetry(() => params.connection.getLatestBlockhash(), sleep, params.config.execution);
 
     const buildTx = async (recentBlockhash: string) => {
@@ -258,6 +273,9 @@ export async function executeOnce(params: ExecuteOnceParams): Promise<ExecuteOnc
         returnVersioned: true,
         // Phase-1: simulate must succeed before prompting wallet.
         simulate: async (tx) => {
+          if (SKIP_PREFLIGHT_SIMULATION_FOR_TESTING) {
+            return { err: null };
+          }
           const sim = await params.connection.simulateTransaction(tx);
           return {
             err: sim.value.err,
@@ -276,12 +294,13 @@ export async function executeOnce(params: ExecuteOnceParams): Promise<ExecuteOnc
       });
     };
 
+    stage = 'build_tx';
     let msg = (await buildTx(latestBlockhash.blockhash)) as VersionedTransaction;
-    const simSummary = 'Simulation passed';
+    const simSummary = SKIP_PREFLIGHT_SIMULATION_FOR_TESTING ? 'Simulation skipped (testing mode)' : 'Simulation passed';
     await params.onSimulationComplete?.(simSummary);
 
-    let sig: string;
     try {
+      stage = 'refresh_blockhash_before_send';
       const refreshedBlockhash = await refreshBlockhashIfNeeded({
         getLatestBlockhash: () => params.connection.getLatestBlockhash(),
         current: { ...latestBlockhash, fetchedAtUnixMs },
@@ -295,10 +314,13 @@ export async function executeOnce(params: ExecuteOnceParams): Promise<ExecuteOnc
         blockhash: refreshedBlockhash.blockhash,
         lastValidBlockHeight: refreshedBlockhash.lastValidBlockHeight,
       };
-      sig = await params.signAndSend(msg);
+      stage = 'wallet_send';
+      sentSig = await params.signAndSend(msg);
+      params.logger?.notify?.('wallet send ok', { sig: sentSig });
     } catch (sendError) {
       const normalized = normalizeSolanaError(sendError);
       if (normalized.code !== 'BLOCKHASH_EXPIRED') throw normalized;
+      stage = 'refresh_blockhash_after_send_error';
       const refreshedBlockhash = await refreshBlockhashIfNeeded({
         getLatestBlockhash: () => params.connection.getLatestBlockhash(),
         current: { ...latestBlockhash, fetchedAtUnixMs },
@@ -313,23 +335,33 @@ export async function executeOnce(params: ExecuteOnceParams): Promise<ExecuteOnc
         blockhash: refreshedBlockhash.blockhash,
         lastValidBlockHeight: refreshedBlockhash.lastValidBlockHeight,
       };
-      sig = await params.signAndSend(msg);
+      stage = 'wallet_send_retry';
+      sentSig = await params.signAndSend(msg);
+      params.logger?.notify?.('wallet send ok (retry)', { sig: sentSig });
     }
 
+    if (!sentSig) {
+      throw new Error('signAndSend returned no signature');
+    }
+
+    stage = 'confirm_transaction';
     await params.connection.confirmTransaction(
       {
-        signature: sig,
+        signature: sentSig,
         blockhash: latestBlockhash.blockhash,
         lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
       },
       'confirmed',
     );
 
+    stage = 'receipt_poll';
     let receipt = null;
-    for (let i = 0; i < params.config.execution.receiptPollMaxAttempts; i += 1) {
-      receipt = await fetchReceiptByPda(params.connection, receiptPda);
-      if (receipt) break;
-      await sleep(params.config.execution.receiptPollIntervalMs);
+    if (!DISABLE_RECEIPT_PROGRAM_FOR_TESTING && receiptPda) {
+      for (let i = 0; i < params.config.execution.receiptPollMaxAttempts; i += 1) {
+        receipt = await fetchReceiptByPda(params.connection, receiptPda);
+        if (receipt) break;
+        await sleep(params.config.execution.receiptPollIntervalMs);
+      }
     }
 
     return {
@@ -339,20 +371,20 @@ export async function executeOnce(params: ExecuteOnceParams): Promise<ExecuteOnc
         unsignedTxBuilt: true,
         simulated: true,
         simLogs: [simSummary],
-        sendSig: sig,
-        receiptPda: receiptPda.toBase58(),
+        sendSig: sentSig,
+        receiptPda: receiptPda?.toBase58(),
         receiptFetched: Boolean(receipt),
         receiptFields: receipt
           ? `authority=${receipt.authority.toBase58()} positionMint=${receipt.positionMint.toBase58()} epoch=${receipt.epoch} direction=${receipt.direction} attestationHash=${Buffer.from(receipt.attestationHash).toString('hex')} slot=${receipt.slot.toString()} unixTs=${receipt.unixTs.toString()} bump=${receipt.bump}`
           : undefined,
       },
       simSummary,
-      txSignature: sig,
-      receiptPda: receiptPda.toBase58(),
+      txSignature: sentSig,
+      receiptPda: receiptPda?.toBase58(),
     };
   } catch (error) {
     const normalized = normalizeSolanaError(error);
-    params.logger?.notifyError?.(error, { reasonCode: normalized.code });
+    params.logger?.notifyError?.(error, { reasonCode: normalized.code, stage, ...(typeof sentSig === 'string' ? { sig: sentSig } : {}) });
     return { status: 'ERROR', errorCode: normalized.code, errorMessage: normalized.message, errorDebug: normalized.debug };
   }
 }
diff --git a/packages/solana/src/executionBuilder.ts b/packages/solana/src/executionBuilder.ts
index 372a63e..c1bde77 100644
--- a/packages/solana/src/executionBuilder.ts
+++ b/packages/solana/src/executionBuilder.ts
@@ -17,7 +17,7 @@ import { buildCreateAtaIdempotentIx, SOL_MINT } from './ata';
 import { fetchJupiterSwapIxs, type JupiterQuote, type JupiterSwapIxs } from './jupiter';
 import type { PositionSnapshot } from './orcaInspector';
 import { buildOrcaExitIxs, type OrcaExitIxs } from './orcaExitBuilder';
-import { buildRecordExecutionIx } from './receipt';
+import { buildRecordExecutionIx, DISABLE_RECEIPT_PROGRAM_FOR_TESTING } from './receipt';
 import { classifySimulationFailure, type SimulationDiagnostics } from './simErrors';
 import type { CanonicalErrorCode } from './types';
 import type { FeeBufferDebugPayload, FeeRequirementsBreakdown } from './requirements';
@@ -353,13 +353,15 @@ export async function buildExitTransaction(
     );
   }
 
-  const receiptIx = buildRecordExecutionIx({
-    authority: config.authority,
-    positionMint: snapshot.positionMint,
-    epoch: canonicalEpoch(config.receiptEpochUnixMs),
-    direction: direction === 'DOWN' ? 0 : 1,
-    attestationHash: config.attestationHash,
-  });
+  const receiptIx = DISABLE_RECEIPT_PROGRAM_FOR_TESTING
+    ? null
+    : buildRecordExecutionIx({
+        authority: config.authority,
+        positionMint: snapshot.positionMint,
+        epoch: canonicalEpoch(config.receiptEpochUnixMs),
+        direction: direction === 'DOWN' ? 0 : 1,
+        attestationHash: config.attestationHash,
+      });
 
   const instructions: TransactionInstruction[] = [
     ...buildComputeBudgetIxs(config),
@@ -370,7 +372,7 @@ export async function buildExitTransaction(
     orca.collectFeesIx,
     ...jup.instructions,
     ...(wsolRequired ? wsolLifecycle.postSwap : []),
-    receiptIx,
+    ...(receiptIx ? [receiptIx] : []),
   ];
 
   const message = new TransactionMessage({
diff --git a/packages/solana/src/jupiter.ts b/packages/solana/src/jupiter.ts
index ecc1b78..d450141 100644
--- a/packages/solana/src/jupiter.ts
+++ b/packages/solana/src/jupiter.ts
@@ -23,6 +23,7 @@ type FetchLike = (input: string, init?: { method?: string; headers?: Record<stri
 }>;
 
 const DEFAULT_BASE = 'https://quote-api.jup.ag/v6';
+const JUPITER_SWAP_DISABLED_FOR_TESTING = true;
 
 function asPk(s: string): PublicKey {
   return new PublicKey(s);
@@ -48,6 +49,19 @@ export async function fetchJupiterQuote(params: {
   fetchImpl?: FetchLike;
   nowUnixMs?: () => number;
 }): Promise<JupiterQuote> {
+  if (JUPITER_SWAP_DISABLED_FOR_TESTING) {
+    // Temporary bypass: synthesize a quote so the rest of the workflow can be tested offline.
+    return {
+      inputMint: params.inputMint,
+      outputMint: params.outputMint,
+      inAmount: params.amount,
+      outAmount: 0n,
+      slippageBps: params.slippageBps,
+      quotedAtUnixMs: (params.nowUnixMs ?? (() => Date.now()))(),
+      raw: { disabled: true, reason: 'JUPITER_SWAP_DISABLED_FOR_TESTING' },
+    };
+  }
+
   const baseUrl = params.baseUrl ?? DEFAULT_BASE;
   const fetchImpl: FetchLike = params.fetchImpl ?? (globalThis.fetch as any);
   if (!fetchImpl) throw new Error('fetch is not available (provide fetchImpl)');
@@ -83,6 +97,11 @@ export async function fetchJupiterSwapIxs(params: {
   fetchImpl?: FetchLike;
   wrapAndUnwrapSol?: boolean;
 }): Promise<JupiterSwapIxs> {
+  if (JUPITER_SWAP_DISABLED_FOR_TESTING) {
+    // Temporary bypass: keep the exit workflow testable while Jupiter swap-instructions is failing.
+    return { instructions: [], lookupTableAddresses: [] };
+  }
+
   const baseUrl = params.baseUrl ?? DEFAULT_BASE;
   const fetchImpl: FetchLike = params.fetchImpl ?? (globalThis.fetch as any);
   if (!fetchImpl) throw new Error('fetch is not available (provide fetchImpl)');
diff --git a/packages/solana/src/orcaExitBuilder.ts b/packages/solana/src/orcaExitBuilder.ts
index 04adaf4..a2ac64b 100644
--- a/packages/solana/src/orcaExitBuilder.ts
+++ b/packages/solana/src/orcaExitBuilder.ts
@@ -1,4 +1,5 @@
 import { PublicKey, TransactionInstruction, type AccountMeta } from '@solana/web3.js';
+import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
 import type { PositionSnapshot } from './orcaInspector';
 import { buildCreateAtaIdempotentIx, getAta } from './ata';
 
@@ -11,16 +12,28 @@ const DISCRIMINATOR_COLLECT_FEES_V2 = Buffer.from([207, 117, 95, 191, 229, 180,
 
 function writeU64LE(v: bigint): Buffer {
   const b = Buffer.alloc(8);
-  b.writeBigUInt64LE(v);
+  let n = BigInt.asUintN(64, v);
+  for (let i = 0; i < 8; i += 1) {
+    b[i] = Number(n & BigInt(0xff));
+    n >>= BigInt(8);
+  }
   return b;
 }
 
 function writeU128LE(v: bigint): Buffer {
   const b = Buffer.alloc(16);
   const lo = BigInt.asUintN(64, v);
-  const hi = v >> BigInt(64);
-  b.writeBigUInt64LE(lo, 0);
-  b.writeBigUInt64LE(hi, 8);
+  const hi = BigInt.asUintN(64, v >> BigInt(64));
+  let n = lo;
+  for (let i = 0; i < 8; i += 1) {
+    b[i] = Number(n & BigInt(0xff));
+    n >>= BigInt(8);
+  }
+  n = hi;
+  for (let i = 0; i < 8; i += 1) {
+    b[8 + i] = Number(n & BigInt(0xff));
+    n >>= BigInt(8);
+  }
   return b;
 }
 
@@ -38,12 +51,18 @@ export function buildOrcaExitIxs(params: {
   authority: PublicKey;
   payer: PublicKey;
 }): OrcaExitIxs {
-  const positionTokenAccount = getAta(params.snapshot.positionMint, params.authority);
+  const positionTokenProgram = params.snapshot.positionTokenProgram ?? TOKEN_PROGRAM_ID;
+  const positionTokenAccount = getAta(params.snapshot.positionMint, params.authority, positionTokenProgram);
   const ownerA = getAta(params.snapshot.tokenMintA, params.authority, params.snapshot.tokenProgramA);
   const ownerB = getAta(params.snapshot.tokenMintB, params.authority, params.snapshot.tokenProgramB);
 
   const conditionalAtaIxs: TransactionInstruction[] = [
-    buildCreateAtaIdempotentIx({ payer: params.payer, owner: params.authority, mint: params.snapshot.positionMint }).ix,
+    buildCreateAtaIdempotentIx({
+      payer: params.payer,
+      owner: params.authority,
+      mint: params.snapshot.positionMint,
+      tokenProgramId: positionTokenProgram,
+    }).ix,
     buildCreateAtaIdempotentIx({ payer: params.payer, owner: params.authority, mint: params.snapshot.tokenMintA, tokenProgramId: params.snapshot.tokenProgramA }).ix,
     buildCreateAtaIdempotentIx({ payer: params.payer, owner: params.authority, mint: params.snapshot.tokenMintB, tokenProgramId: params.snapshot.tokenProgramB }).ix,
   ];
diff --git a/packages/solana/src/orcaInspector.ts b/packages/solana/src/orcaInspector.ts
index b65db98..35687aa 100644
--- a/packages/solana/src/orcaInspector.ts
+++ b/packages/solana/src/orcaInspector.ts
@@ -5,16 +5,19 @@ import {
   decreaseLiquidityQuoteByLiquidityWithParams,
   NO_TOKEN_EXTENSION_CONTEXT,
   PDAUtil,
+  ParsablePosition,
+  ParsableWhirlpool,
   PriceMath,
 } from '@orca-so/whirlpools-sdk';
+import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
 import { PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';
 import { normalizeSolanaError } from './errors';
 import { loadSolanaConfig } from './config';
 import type { CanonicalErrorCode, NormalizedError } from './types';
 
 const ORCA_WHIRLPOOL_PROGRAM_ID = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
-const TOKEN_PROGRAM_V1 = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
-const TOKEN_PROGRAM_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkA6Ww2c47QhN7f6vYfP2D4W3');
+const TOKEN_PROGRAM_V1 = TOKEN_PROGRAM_ID;
+const TOKEN_PROGRAM_2022 = TOKEN_2022_PROGRAM_ID;
 
 export type RemovePreviewReasonCode = 'QUOTE_UNAVAILABLE' | 'DATA_UNAVAILABLE';
 
@@ -30,6 +33,7 @@ export type PositionSnapshot = {
   whirlpool: PublicKey;
   position: PublicKey;
   positionMint: PublicKey;
+  positionTokenProgram?: PublicKey;
   currentTickIndex: number;
   lowerTickIndex: number;
   upperTickIndex: number;
@@ -130,6 +134,23 @@ function parsePositionAccount(data: Buffer): ParsedPosition {
   };
 }
 
+function parsePositionAccountFromInfo(
+  address: PublicKey,
+  info: AccountInfo<Buffer>,
+): ParsedPosition {
+  const parsed = ParsablePosition.parse(address, info);
+  if (parsed) {
+    return {
+      whirlpool: parsed.whirlpool,
+      positionMint: parsed.positionMint,
+      liquidity: BigInt(parsed.liquidity.toString()),
+      lowerTickIndex: parsed.tickLowerIndex,
+      upperTickIndex: parsed.tickUpperIndex,
+    };
+  }
+  return parsePositionAccount(info.data);
+}
+
 function parseWhirlpoolAccount(data: Buffer): ParsedWhirlpool {
   if (data.length < 220) throw makeError('DATA_UNAVAILABLE', 'whirlpool account too small');
   return {
@@ -142,6 +163,24 @@ function parseWhirlpoolAccount(data: Buffer): ParsedWhirlpool {
   };
 }
 
+function parseWhirlpoolAccountFromInfo(
+  address: PublicKey,
+  info: AccountInfo<Buffer>,
+): ParsedWhirlpool {
+  const parsed = ParsableWhirlpool.parse(address, info);
+  if (parsed) {
+    return {
+      tickSpacing: parsed.tickSpacing,
+      currentTickIndex: parsed.tickCurrentIndex,
+      tokenMintA: parsed.tokenMintA,
+      tokenMintB: parsed.tokenMintB,
+      tokenVaultA: parsed.tokenVaultA,
+      tokenVaultB: parsed.tokenVaultB,
+    };
+  }
+  return parseWhirlpoolAccount(info.data);
+}
+
 function parseMintMeta(info: AccountInfo<Buffer> | null): MintMeta {
   if (!info || info.data.length < 45) throw makeError('DATA_UNAVAILABLE', 'mint account unavailable');
   return {
@@ -226,19 +265,21 @@ export async function loadPositionSnapshot(
     const positionInfo = await connection.getAccountInfo(positionPubkey, 'confirmed');
     if (!positionInfo) throw makeError('INVALID_POSITION', 'position account not found');
 
-    const position = parsePositionAccount(positionInfo.data);
+    const position = parsePositionAccountFromInfo(positionPubkey, positionInfo);
 
     const whirlpoolInfo = await connection.getAccountInfo(position.whirlpool, 'confirmed');
     if (!whirlpoolInfo) throw makeError('DATA_UNAVAILABLE', 'whirlpool account not found');
-    const whirlpool = parseWhirlpoolAccount(whirlpoolInfo.data);
+    const whirlpool = parseWhirlpoolAccountFromInfo(position.whirlpool, whirlpoolInfo);
 
     const cluster = clusterOverride ?? loadSolanaConfig(process.env).cluster;
     assertSolUsdcPair(whirlpool.tokenMintA.toBase58(), whirlpool.tokenMintB.toBase58(), cluster);
 
-    const [mintAInfo, mintBInfo] = await Promise.all([
+    const [positionMintInfo, mintAInfo, mintBInfo] = await Promise.all([
+      connection.getAccountInfo(position.positionMint, 'confirmed'),
       connection.getAccountInfo(whirlpool.tokenMintA, 'confirmed'),
       connection.getAccountInfo(whirlpool.tokenMintB, 'confirmed'),
     ]);
+    const positionMintMeta = parseMintMeta(positionMintInfo);
     const mintA = parseMintMeta(mintAInfo);
     const mintB = parseMintMeta(mintBInfo);
     const pairLabel = getCanonicalPairLabel(cluster);
@@ -268,6 +309,7 @@ export async function loadPositionSnapshot(
       whirlpool: position.whirlpool,
       position: positionPubkey,
       positionMint: position.positionMint,
+      positionTokenProgram: tokenProgramForOwner(positionMintMeta.owner),
       currentTickIndex: whirlpool.currentTickIndex,
       lowerTickIndex: position.lowerTickIndex,
       upperTickIndex: position.upperTickIndex,
diff --git a/packages/solana/src/receipt.ts b/packages/solana/src/receipt.ts
index cd5d7cd..16fdf59 100644
--- a/packages/solana/src/receipt.ts
+++ b/packages/solana/src/receipt.ts
@@ -10,6 +10,7 @@ import {
 type Direction = 0 | 1;
 
 export const RECEIPT_PROGRAM_ID = new PublicKey('A81Xsuwg5zrT1sgvkncemfWqQ8nymwHS3e7ExM4YnXMm');
+export const DISABLE_RECEIPT_PROGRAM_FOR_TESTING = true;
 
 export type ReceiptAccount = {
   authority: PublicKey;
diff --git a/packages/solana/src/requirements.ts b/packages/solana/src/requirements.ts
index 9a3a564..6039688 100644
--- a/packages/solana/src/requirements.ts
+++ b/packages/solana/src/requirements.ts
@@ -14,7 +14,7 @@ export type FeeRequirementsBreakdown = {
 
 export type RequirementsInput = {
   connection: Pick<Connection, 'getAccountInfo' | 'getMinimumBalanceForRentExemption'>;
-  snapshot: Pick<PositionSnapshot, 'positionMint' | 'tokenMintA' | 'tokenMintB' | 'tokenProgramA' | 'tokenProgramB'>;
+  snapshot: Pick<PositionSnapshot, 'positionMint' | 'positionTokenProgram' | 'tokenMintA' | 'tokenMintB' | 'tokenProgramA' | 'tokenProgramB'>;
   quote: { inputMint: PublicKey; outputMint: PublicKey };
 
   authority: PublicKey;
@@ -51,7 +51,7 @@ export async function computeExecutionRequirements(input: RequirementsInput): Pr
   };
 
   // Orca exit always needs these token accounts (position token + the pool mints A/B).
-  addAta(input.snapshot.positionMint);
+  addAta(input.snapshot.positionMint, input.snapshot.positionTokenProgram ?? TOKEN_PROGRAM_ID);
   addAta(input.snapshot.tokenMintA, input.snapshot.tokenProgramA);
   addAta(input.snapshot.tokenMintB, input.snapshot.tokenProgramB);
 
```
