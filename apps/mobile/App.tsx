import { useMemo, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import * as Clipboard from 'expo-clipboard';
import { Button, SafeAreaView, ScrollView, Text, TextInput } from 'react-native';
import { Connection, PublicKey, SystemProgram, VersionedTransaction } from '@solana/web3.js';
import { createConsoleNotificationsAdapter } from '@clmm-autopilot/notifications';
import { executeOnce, refreshPositionDecision } from '@clmm-autopilot/solana';
import { buildUiModel, mapErrorToUi, type UiModel } from '@clmm-autopilot/ui-state';
import { runMwaSignAndSendVersionedTransaction, runMwaSignMessageSmoke } from './src/mwaSmoke';

export default function App() {
  const notifications = useMemo(() => createConsoleNotificationsAdapter(), []);
  const [wallet, setWallet] = useState('');
  const [positionAddress, setPositionAddress] = useState('');
  const [ui, setUi] = useState<UiModel>(buildUiModel({}));
  const [simSummary, setSimSummary] = useState('N/A');

  const canExecute = Boolean(wallet && positionAddress && ui.decision?.decision !== 'HOLD');

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#fff' }}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        <Text style={{ fontSize: 24, fontWeight: '700' }}>M6 Shell UX</Text>
        <Button title={wallet ? 'Wallet Connected' : 'Connect Wallet'} onPress={async () => setWallet((await runMwaSignMessageSmoke()).publicKey)} />
        <TextInput placeholder="Orca position account" value={positionAddress} onChangeText={setPositionAddress} style={{ borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 10 }} />
        <Button
          title="Refresh"
          disabled={!positionAddress}
          onPress={async () => {
            try {
              const r = await refreshPositionDecision({
                connection: new Connection('https://api.devnet.solana.com', 'confirmed'),
                position: new PublicKey(positionAddress),
                samples: [
                  { slot: 1, unixTs: 1_700_000_000, currentTickIndex: 0 },
                  { slot: 2, unixTs: 1_700_000_002, currentTickIndex: 0 },
                  { slot: 3, unixTs: 1_700_000_004, currentTickIndex: 0 },
                ],
                slippageBpsCap: 50,
                expectedMinOut: 'N/A',
                quoteAgeMs: 0,
              });
              setUi(buildUiModel({ snapshot: r.snapshot, decision: r.decision, quote: r.quote }));
            } catch (e) {
              const mapped = mapErrorToUi(e);
              setUi(buildUiModel({ lastError: `${mapped.code}: ${mapped.message}` }));
            }
          }}
        />
        <Button
          title="Execute"
          disabled={!canExecute}
          onPress={async () => {
            const authority = new PublicKey(wallet);
            const position = new PublicKey(positionAddress);
            const result = await executeOnce({
              connection: new Connection('https://api.devnet.solana.com', 'confirmed'),
              authority,
              position,
              samples: [
                { slot: 1, unixTs: 1_700_000_000, currentTickIndex: 0 },
                { slot: 2, unixTs: 1_700_000_002, currentTickIndex: 0 },
                { slot: 3, unixTs: 1_700_000_004, currentTickIndex: 0 },
              ],
              quote: { inputMint: new PublicKey('So11111111111111111111111111111111111111112'), outputMint: new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'), slippageBps: 50, quotedAtUnixMs: Date.now() },
              slippageBpsCap: 50,
              expectedMinOut: 'N/A',
              quoteAgeMs: 0,
              removeLiquidityIx: SystemProgram.transfer({ fromPubkey: authority, toPubkey: authority, lamports: 0 }),
              collectFeesIx: SystemProgram.transfer({ fromPubkey: authority, toPubkey: authority, lamports: 0 }),
              swapIx: SystemProgram.transfer({ fromPubkey: authority, toPubkey: authority, lamports: 0 }),
              wsolLifecycleIxs: { preSwap: [], postSwap: [] },
              attestationHash: new Uint8Array(32),
              onSimulationComplete: (s) => setSimSummary(`${s} — ready for wallet prompt`),
              signAndSend: async (tx: VersionedTransaction) => (await runMwaSignAndSendVersionedTransaction(tx)).signature,
              logger: notifications,
            });
            setUi(
              buildUiModel({
                snapshot: result.refresh?.snapshot,
                decision: result.refresh?.decision,
                quote: result.refresh?.quote,
                execution: result.execution,
                lastError: result.errorCode ? `${result.errorCode}: ${result.errorMessage ?? ''}` : undefined,
              }),
            );
          }}
        />

        <Text>current tick: {ui.snapshot?.currentTick ?? 'N/A'}</Text><Text>lower tick: {ui.snapshot?.lowerTick ?? 'N/A'}</Text><Text>upper tick: {ui.snapshot?.upperTick ?? 'N/A'}</Text>
        <Text>decision: {ui.decision?.decision ?? 'N/A'}</Text><Text>reasonCode: {ui.decision?.reasonCode ?? 'N/A'}</Text>
        <Text>debounce progress: {ui.decision ? `${ui.decision.samplesUsed}/${ui.decision.threshold}` : 'N/A'}</Text>
        <Text>pending confirm: {ui.decision && ui.decision.samplesUsed < ui.decision.threshold ? 'yes' : 'no'}</Text>
        <Text>cooldown remaining (ms): {ui.decision?.cooldownRemainingMs ?? 'N/A'}</Text>
        <Text>slippage cap: {ui.quote?.slippageBpsCap ?? 'N/A'}</Text><Text>expected minOut: {ui.quote?.expectedMinOut ?? 'N/A'}</Text><Text>quote age (ms): {ui.quote?.quoteAgeMs ?? 'N/A'}</Text>
        <Text>simulate summary: {simSummary}</Text>

        <Text>tx signature: {ui.execution?.sendSig ?? 'N/A'}</Text>
        <Button title="Copy tx signature" disabled={!ui.execution?.sendSig} onPress={() => Clipboard.setStringAsync(ui.execution?.sendSig ?? '')} />
        <Text>receipt PDA: {ui.execution?.receiptPda ?? 'N/A'}</Text>
        <Button title="Copy receipt PDA" disabled={!ui.execution?.receiptPda} onPress={() => Clipboard.setStringAsync(ui.execution?.receiptPda ?? '')} />
        <Text>receipt fields: {ui.execution?.receiptFields ?? 'N/A'}</Text>
        {ui.lastError ? <Text style={{ color: 'red' }}>{ui.lastError}</Text> : null}
      </ScrollView>
      <StatusBar style="auto" />
    </SafeAreaView>
  );
}
