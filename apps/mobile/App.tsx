import { useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import * as Clipboard from 'expo-clipboard';
import { Button, SafeAreaView, ScrollView, Text, TextInput } from 'react-native';
import { Connection, PublicKey, SystemProgram, VersionedTransaction } from '@solana/web3.js';
import { executeOnce } from '@clmm-autopilot/solana';
import { buildUiModel, mapErrorToUi, type UiModel } from '@clmm-autopilot/ui-state';
import { runMwaSignMessageSmoke, runMwaSignAndSendVersionedTransaction } from './src/mwaSmoke';

export default function App() {
  const [wallet, setWallet] = useState('');
  const [positionAddress, setPositionAddress] = useState('');
  const [ui, setUi] = useState<UiModel>(buildUiModel({}));

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#fff' }}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        <Text style={{ fontSize: 24, fontWeight: '700' }}>M6 Shell UX</Text>

        <Button
          title={wallet ? 'Wallet Connected' : 'Connect Wallet'}
          onPress={async () => {
            try {
              const result = await runMwaSignMessageSmoke();
              setWallet(result.publicKey);
            } catch (e) {
              const mapped = mapErrorToUi(e);
              setUi(buildUiModel({ ...ui, lastError: `${mapped.code}: ${mapped.message}` }));
            }
          }}
        />

        <TextInput
          placeholder="Orca position account"
          value={positionAddress}
          onChangeText={setPositionAddress}
          style={{ borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 10 }}
        />

        <Button
          title="Execute"
          disabled={!wallet || !positionAddress || ui.decision?.decision === 'HOLD'}
          onPress={async () => {
            try {
              const authority = new PublicKey(wallet);
              const position = new PublicKey(positionAddress);
              const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
              const result = await executeOnce({
                connection,
                authority,
                position,
                samples: [
                  { slot: 1, unixTs: 1_700_000_000, currentTickIndex: 0 },
                  { slot: 2, unixTs: 1_700_000_002, currentTickIndex: 0 },
                  { slot: 3, unixTs: 1_700_000_004, currentTickIndex: 0 },
                ],
                quote: {
                  inputMint: new PublicKey('So11111111111111111111111111111111111111112'),
                  outputMint: new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
                  slippageBps: 50,
                  quotedAtUnixMs: Date.now(),
                },
                slippageBpsCap: 50,
                expectedMinOut: 'N/A',
                quoteAgeMs: 0,
                removeLiquidityIx: SystemProgram.transfer({ fromPubkey: authority, toPubkey: authority, lamports: 0 }),
                collectFeesIx: SystemProgram.transfer({ fromPubkey: authority, toPubkey: authority, lamports: 0 }),
                swapIx: SystemProgram.transfer({ fromPubkey: authority, toPubkey: authority, lamports: 0 }),
                wsolLifecycleIxs: {
                  preSwap: [SystemProgram.transfer({ fromPubkey: authority, toPubkey: authority, lamports: 0 })],
                  postSwap: [SystemProgram.transfer({ fromPubkey: authority, toPubkey: authority, lamports: 0 })],
                },
                attestationHash: new Uint8Array(32),
                signAndSend: async (tx: VersionedTransaction) => (await runMwaSignAndSendVersionedTransaction(tx)).signature,
              });
              setUi(result.ui);
            } catch (e) {
              const mapped = mapErrorToUi(e);
              setUi(buildUiModel({ ...ui, lastError: `${mapped.code}: ${mapped.message}` }));
            }
          }}
        />

        <Text>current tick: {ui.snapshot?.currentTick ?? 'N/A'}</Text>
        <Text>lower tick: {ui.snapshot?.lowerTick ?? 'N/A'}</Text>
        <Text>upper tick: {ui.snapshot?.upperTick ?? 'N/A'}</Text>
        <Text>decision: {ui.decision?.decision ?? 'N/A'}</Text>
        <Text>reasonCode: {ui.decision?.reasonCode ?? 'N/A'}</Text>
        <Text>debounce progress: {ui.decision ? `${ui.decision.samplesUsed}/${ui.decision.threshold}` : 'N/A'}</Text>
        <Text>cooldown remaining (ms): {ui.decision?.cooldownRemainingMs ?? 'N/A'}</Text>
        <Text>slippage cap: {ui.quote?.slippageBpsCap ?? 'N/A'}</Text>
        <Text>expected minOut: {ui.quote?.expectedMinOut ?? 'N/A'}</Text>
        <Text>quote age (ms): {ui.quote?.quoteAgeMs ?? 'N/A'}</Text>

        <Text>receipt PDA: {ui.execution?.receiptPda ?? 'N/A'}</Text>
        <Button title="Copy receipt PDA" disabled={!ui.execution?.receiptPda} onPress={() => Clipboard.setStringAsync(ui.execution?.receiptPda ?? '')} />
        <Text>tx signature: {ui.execution?.sendSig ?? 'N/A'}</Text>
        <Button title="Copy tx signature" disabled={!ui.execution?.sendSig} onPress={() => Clipboard.setStringAsync(ui.execution?.sendSig ?? '')} />
        <Text>receipt fields: {ui.execution?.receiptFields ?? 'N/A'}</Text>

        {ui.lastError ? <Text style={{ color: 'red' }}>{ui.lastError}</Text> : null}
      </ScrollView>
      <StatusBar style="auto" />
    </SafeAreaView>
  );
}
