import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { Button, SafeAreaView, ScrollView, Text, View } from 'react-native';
import { runMwaSignMessageSmoke } from './src/mwaSmoke';

export default function App() {
  const [publicKey, setPublicKey] = useState<string>('');
  const [signature, setSignature] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [busy, setBusy] = useState(false);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#fff' }}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        <Text style={{ fontSize: 24, fontWeight: '700' }}>M1 MWA Smoke</Text>
        <Text>Connect wallet and sign message on devnet.</Text>
        <Button
          title={busy ? 'Signing…' : 'Run MWA sign-message smoke'}
          disabled={busy}
          onPress={async () => {
            setBusy(true);
            setError('');
            try {
              const result = await runMwaSignMessageSmoke();
              setPublicKey(result.publicKey);
              setSignature(result.signatureHex);
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        />

        <View style={{ gap: 6 }}>
          <Text style={{ fontWeight: '600' }}>Public key</Text>
          <Text selectable>{publicKey || '—'}</Text>
        </View>

        <View style={{ gap: 6 }}>
          <Text style={{ fontWeight: '600' }}>Signature (hex)</Text>
          <Text selectable>{signature || '—'}</Text>
        </View>

        {error ? (
          <View style={{ gap: 6 }}>
            <Text style={{ fontWeight: '600', color: 'red' }}>Error</Text>
            <Text selectable style={{ color: 'red' }}>{error}</Text>
          </View>
        ) : null}
      </ScrollView>
      <StatusBar style="auto" />
    </SafeAreaView>
  );
}
