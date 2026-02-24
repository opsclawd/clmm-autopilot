import { useEffect, useMemo, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import * as Clipboard from 'expo-clipboard';
import { Button, SafeAreaView, ScrollView, Text, TextInput } from 'react-native';
import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { createConsoleNotificationsAdapter } from '@clmm-autopilot/notifications';
import { executeOnce, fetchJupiterQuote, loadPositionSnapshot, refreshPositionDecision } from '@clmm-autopilot/solana';
import { computeAttestationHash, encodeAttestationPayload, unixDaysFromUnixMs } from '@clmm-autopilot/core';
import { buildUiModel, mapErrorToUi, type UiModel } from '@clmm-autopilot/ui-state';
import { runMwaSignAndSendVersionedTransaction, runMwaSignMessageSmoke } from './src/mwaSmoke';

const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const CLUSTER = 'devnet' as const;

type Sample = { slot: number; unixTs: number; currentTickIndex: number };

export default function App() {
  const notifications = useMemo(() => createConsoleNotificationsAdapter(), []);
  const [wallet, setWallet] = useState('');
  const [positionAddress, setPositionAddress] = useState('');
  const [ui, setUi] = useState<UiModel>(buildUiModel({}));
  const [simSummary, setSimSummary] = useState('N/A');
  const [samples, setSamples] = useState<Sample[]>([]);
  const [attestationDebugPrefix, setAttestationDebugPrefix] = useState('N/A');
  const monitorRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const canExecute = Boolean(wallet && positionAddress && ui.canExecute);

  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

  useEffect(() => {
    if (monitorRef.current) {
      clearInterval(monitorRef.current);
      monitorRef.current = null;
    }
    setSamples([]);

    if (!positionAddress) return;

    let cancelled = false;
    const poll = async () => {
      try {
        const snapshot = await loadPositionSnapshot(connection, new PublicKey(positionAddress), CLUSTER);
        const slot = await connection.getSlot('confirmed');
        const unixTs = Math.floor(Date.now() / 1000);
        if (cancelled) return;
        setSamples((prev) => [...prev, { slot, unixTs, currentTickIndex: snapshot.currentTickIndex }].slice(-90));
      } catch {
        // keep monitor resilient; manual refresh surfaces explicit errors
      }
    };

    void poll();
    monitorRef.current = setInterval(() => void poll(), 2000);

    return () => {
      cancelled = true;
      if (monitorRef.current) {
        clearInterval(monitorRef.current);
        monitorRef.current = null;
      }
    };
  }, [positionAddress]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#fff' }}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        <Text style={{ fontSize: 24, fontWeight: '700' }}>M6 Shell UX</Text>
        <Button
          title={wallet ? 'Wallet Connected' : 'Connect Wallet'}
          onPress={async () => setWallet((await runMwaSignMessageSmoke()).publicKey)}
        />

        <TextInput
          placeholder="Orca position account"
          value={positionAddress}
          onChangeText={setPositionAddress}
          style={{ borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 10 }}
        />

        <Button
          title="Refresh"
          disabled={!positionAddress}
          onPress={async () => {
            try {
              const snapshot = await loadPositionSnapshot(connection, new PublicKey(positionAddress), CLUSTER);
              const slot = await connection.getSlot('confirmed');
              const unixTs = Math.floor(Date.now() / 1000);
              const nextSamples = [...samples, { slot, unixTs, currentTickIndex: snapshot.currentTickIndex }].slice(-90);
              setSamples(nextSamples);

              const r = await refreshPositionDecision({
                connection,
                position: new PublicKey(positionAddress),
                samples: nextSamples,
                slippageBpsCap: 50,
                expectedMinOut: 'N/A',
                quoteAgeMs: 0,
              });
              setUi(buildUiModel({ snapshot: r.snapshot, decision: r.decision, quote: r.quote }));
            } catch (e) {
              const mapped = mapErrorToUi(e);
              setUi(
                buildUiModel({
                  decision:
                    mapped.code === 'NOT_SOL_USDC'
                      ? { decision: 'HOLD', reasonCode: 'NOT_SOL_USDC', samplesUsed: 0, threshold: 0, cooldownRemainingMs: 0 }
                      : undefined,
                  snapshot:
                    mapped.code === 'NOT_SOL_USDC' && positionAddress
                      ? {
                          positionAddress,
                          currentTick: 0,
                          lowerTick: 0,
                          upperTick: 0,
                          inRange: false,
                          pairLabel: 'UNSUPPORTED',
                          pairValid: false,
                        }
                      : undefined,
                  lastError: `${mapped.code}: ${mapped.message}`,
                }),
              );
            }
          }}
        />

        <Button
          title="Execute"
          disabled={!canExecute}
          onPress={async () => {
            try {
              const authority = new PublicKey(wallet);
              const position = new PublicKey(positionAddress);
              const snapshot = await loadPositionSnapshot(connection, position, CLUSTER);
              const dir = ui.decision?.decision === 'TRIGGER_UP' ? 'UP' : 'DOWN';
              if (!snapshot.removePreview) throw new Error(`Remove preview unavailable (${snapshot.removePreviewReasonCode ?? 'DATA_UNAVAILABLE'})`);

              const tokenAOut = snapshot.removePreview.tokenAOut;
              const tokenBOut = snapshot.removePreview.tokenBOut;
              const inputMint = dir === 'DOWN' ? SOL_MINT : (snapshot.tokenMintA.equals(SOL_MINT) ? snapshot.tokenMintB : snapshot.tokenMintA);
              const outputMint = dir === 'DOWN' ? (snapshot.tokenMintA.equals(SOL_MINT) ? snapshot.tokenMintB : snapshot.tokenMintA) : SOL_MINT;
              const amount = dir === 'DOWN'
                ? (snapshot.tokenMintA.equals(SOL_MINT) ? tokenAOut : tokenBOut)
                : (snapshot.tokenMintA.equals(SOL_MINT) ? tokenBOut : tokenAOut);

              const quote = await fetchJupiterQuote({ inputMint, outputMint, amount, slippageBps: 50 });
              const observedSlot = await connection.getSlot('confirmed');
              const epochNowMs = Date.now();
              const observedUnixTs = Math.floor(epochNowMs / 1000);
              const epoch = unixDaysFromUnixMs(epochNowMs);
              const attestationInput = {
                authority: authority.toBase58(),
                positionMint: snapshot.positionMint.toBase58(),
                epoch,
                direction: dir === 'UP' ? (1 as const) : (0 as const),
                lowerTickIndex: snapshot.lowerTickIndex,
                upperTickIndex: snapshot.upperTickIndex,
                currentTickIndex: snapshot.currentTickIndex,
                observedSlot: BigInt(observedSlot),
                observedUnixTs: BigInt(observedUnixTs),
                quoteInputMint: quote.inputMint.toBase58(),
                quoteOutputMint: quote.outputMint.toBase58(),
                quoteInAmount: quote.inAmount,
                quoteOutAmount: quote.outAmount,
                quoteSlippageBps: quote.slippageBps,
                quoteQuotedAtUnixMs: BigInt(quote.quotedAtUnixMs),
                computeUnitLimit: 600000,
                computeUnitPriceMicroLamports: BigInt(10000),
                maxSlippageBps: 50,
                quoteFreshnessMs: BigInt(20000),
                maxRebuildAttempts: 3,
              };
              const attestationPayloadBytes = encodeAttestationPayload(attestationInput);
              const attestationHash = computeAttestationHash(attestationInput);
              setAttestationDebugPrefix(Buffer.from(attestationHash).toString('hex').slice(0, 12));

              const result = await executeOnce({
                connection,
                authority,
                position,
                samples,
                quote,
                slippageBpsCap: 50,
                expectedMinOut: quote.outAmount.toString(),
                quoteAgeMs: 0,
                attestationHash,
                attestationPayloadBytes,
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
                  lastError:
                    result.status === 'ERROR' && result.errorCode
                      ? (() => {
                          const mapped = mapErrorToUi({ code: result.errorCode, debug: result.errorDebug, message: result.errorMessage });
                          return `${mapped.code}: ${mapped.message}`;
                        })()
                      : undefined,
                }),
              );
            } catch (e) {
              const mapped = mapErrorToUi(e);
              setUi(buildUiModel({ lastError: `${mapped.code}: ${mapped.message}` }));
            }
          }}
        />

        <Text>current tick: {ui.snapshot?.currentTick ?? 'N/A'}</Text>
        <Text>lower tick: {ui.snapshot?.lowerTick ?? 'N/A'}</Text>
        <Text>upper tick: {ui.snapshot?.upperTick ?? 'N/A'}</Text>
        <Text>decision: {ui.decision?.decision ?? 'N/A'}</Text>
        <Text>reasonCode: {ui.decision?.reasonCode ?? 'N/A'}</Text>
        <Text>debounce progress: {ui.decision ? `${ui.decision.samplesUsed}/${ui.decision.threshold}` : 'N/A'}</Text>
        <Text>pending confirm: {ui.decision && ui.decision.samplesUsed < ui.decision.threshold ? 'yes' : 'no'}</Text>
        <Text>cooldown remaining (ms): {ui.decision?.cooldownRemainingMs ?? 'N/A'}</Text>
        <Text>slippage cap: {ui.quote?.slippageBpsCap ?? 'N/A'}</Text>
        <Text>expected minOut: {ui.quote?.expectedMinOut ?? 'N/A'}</Text>
        <Text>quote age (ms): {ui.quote?.quoteAgeMs ?? 'N/A'}</Text>
        <Text>pair: {ui.snapshot?.pairLabel ?? 'N/A'}</Text>
        <Text>pair valid: {ui.snapshot?.pairValid === undefined ? 'N/A' : ui.snapshot?.pairValid ? 'yes' : 'no'}</Text>
        <Text>samples buffered: {samples.length}</Text>
        <Text>simulate summary: {simSummary}</Text>
        <Text>attestation hash (prefix): {attestationDebugPrefix}</Text>

        <Text>tx signature: {ui.execution?.sendSig ?? 'N/A'}</Text>
        <Button
          title="Copy tx signature"
          disabled={!ui.execution?.sendSig}
          onPress={() => Clipboard.setStringAsync(ui.execution?.sendSig ?? '')}
        />
        <Text>receipt PDA: {ui.execution?.receiptPda ?? 'N/A'}</Text>
        <Button
          title="Copy receipt PDA"
          disabled={!ui.execution?.receiptPda}
          onPress={() => Clipboard.setStringAsync(ui.execution?.receiptPda ?? '')}
        />
        <Text>receipt fields: {ui.execution?.receiptFields ?? 'N/A'}</Text>

        {ui.lastError ? <Text style={{ color: 'red' }}>{ui.lastError}</Text> : null}
      </ScrollView>
      <StatusBar style="auto" />
    </SafeAreaView>
  );
}
