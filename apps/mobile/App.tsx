import { useEffect, useMemo, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import * as Clipboard from 'expo-clipboard';
import { Button, SafeAreaView, ScrollView, Text, TextInput } from 'react-native';
import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { createConsoleNotificationsAdapter } from '@clmm-autopilot/notifications';
import { executeOnce, loadPositionSnapshot, refreshPositionDecision } from '@clmm-autopilot/solana';
import { type PolicyState } from '@clmm-autopilot/core';
import { loadAutopilotConfig, loadMobileRuntimeConfig } from './src/config';
import { buildUiModel, mapErrorToUi, type UiModel } from '@clmm-autopilot/ui-state';
import { runMwaSignAndSendVersionedTransaction, runMwaSignMessageSmoke } from './src/mwaSmoke';

type Sample = { slot: number; unixTs: number; currentTickIndex: number };

export default function App() {
  const notifications = useMemo(() => createConsoleNotificationsAdapter(), []);
  const loaded = useMemo(() => loadAutopilotConfig(), []);
  const runtimeConfig = useMemo(() => loadMobileRuntimeConfig(), []);
  const autopilotConfig = loaded.config;
  const configValid = loaded.ok;
  const [wallet, setWallet] = useState('');
  const [positionAddress, setPositionAddress] = useState('');
  const [ui, setUi] = useState<UiModel>(buildUiModel({}));
  const [simSummary, setSimSummary] = useState('N/A');
  const [samples, setSamples] = useState<Sample[]>([]);
  const previewPolicyStateRef = useRef<PolicyState>({});
  const executionPolicyStateRef = useRef<PolicyState>({});
  const monitorRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const canExecute = Boolean(configValid && wallet && positionAddress && ui.canExecute);

  const connection = useMemo(
    () => new Connection(runtimeConfig.rpcUrl, runtimeConfig.commitment),
    [runtimeConfig.rpcUrl, runtimeConfig.commitment],
  );

  useEffect(() => {
    if (monitorRef.current) {
      clearInterval(monitorRef.current);
      monitorRef.current = null;
    }
    setSamples([]);
    previewPolicyStateRef.current = {};
    executionPolicyStateRef.current = {};

    if (!positionAddress) return;

    let cancelled = false;
    const poll = async () => {
      try {
        const snapshot = await loadPositionSnapshot(connection, new PublicKey(positionAddress), autopilotConfig.cluster);
        const slot = await connection.getSlot('confirmed');
        const unixTs = Math.floor(Date.now() / 1000);
        if (cancelled) return;
        setSamples((prev) =>
          [...prev, { slot, unixTs, currentTickIndex: snapshot.currentTickIndex }].slice(-autopilotConfig.ui.sampleBufferSize),
        );
      } catch {
        // keep monitor resilient; manual refresh surfaces explicit errors
      }
    };

    void poll();
    monitorRef.current = setInterval(() => void poll(), autopilotConfig.policy.cadenceMs);

    return () => {
      cancelled = true;
      if (monitorRef.current) {
        clearInterval(monitorRef.current);
        monitorRef.current = null;
      }
    };
  }, [positionAddress, autopilotConfig.policy.cadenceMs, autopilotConfig.cluster, autopilotConfig.ui.sampleBufferSize, connection]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#fff' }}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        <Text style={{ fontSize: 24, fontWeight: '700' }}>Shell UX</Text>
        {!configValid ? (
          <Text style={{ color: '#b91c1c' }}>
            {mapErrorToUi({ code: 'CONFIG_INVALID' }).title}: {mapErrorToUi({ code: 'CONFIG_INVALID' }).message}
          </Text>
        ) : null}
        {!loaded.ok ? loaded.errors.map((e) => (
          <Text key={`${e.path}:${e.code}`} style={{ color: '#b91c1c', fontSize: 12 }}>
            {e.path}: {e.message} {e.expected ? `(expected ${e.expected})` : ''}
          </Text>
        )) : null}
        <Text style={{ fontSize: 12, color: "#111" }}>
          cadenceMs={autopilotConfig.policy.cadenceMs} requiredConsecutive={autopilotConfig.policy.requiredConsecutive} cooldownMs={autopilotConfig.policy.cooldownMs}
        </Text>
        <Text style={{ fontSize: 12, color: "#111" }}>
          slippageBpsCap={autopilotConfig.execution.slippageBpsCap} quoteFreshnessSec={autopilotConfig.execution.quoteFreshnessSec}
        </Text>
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
          disabled={!configValid || !positionAddress}
          onPress={async () => {
            try {
              const snapshot = await loadPositionSnapshot(connection, new PublicKey(positionAddress), autopilotConfig.cluster);
              const slot = await connection.getSlot('confirmed');
              const unixTs = Math.floor(Date.now() / 1000);
              const nextSamples = [...samples, { slot, unixTs, currentTickIndex: snapshot.currentTickIndex }].slice(
                -autopilotConfig.ui.sampleBufferSize,
              );
              setSamples(nextSamples);

              const r = await refreshPositionDecision({
                connection,
                position: new PublicKey(positionAddress),
                samples: nextSamples,
                config: autopilotConfig,
                policyState: previewPolicyStateRef.current,
                expectedMinOut: 'N/A',
                quoteAgeMs: 0,
              });
              previewPolicyStateRef.current = r.decision.nextState;
              setUi(buildUiModel({
                config: {
                  policy: autopilotConfig.policy,
                  execution: {
                    slippageBpsCap: autopilotConfig.execution.slippageBpsCap,
                    quoteFreshnessMs: autopilotConfig.execution.quoteFreshnessSec * 1000,
                  },
                },
                snapshot: r.snapshot,
                decision: r.decision,
                quote: r.quote,
              }));
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
              const result = await executeOnce({
                connection,
                authority,
                position,
                samples,
                config: autopilotConfig,
                policyState: executionPolicyStateRef.current,
                expectedMinOut: 'N/A',
                quoteAgeMs: 0,
                onSimulationComplete: (s) => setSimSummary(`${s} — ready for wallet prompt`),
                signAndSend: async (tx: VersionedTransaction) => (await runMwaSignAndSendVersionedTransaction(tx)).signature,
                logger: notifications,
              });

              if (result.refresh?.decision?.nextState) {
                executionPolicyStateRef.current = result.refresh.decision.nextState;
                previewPolicyStateRef.current = result.refresh.decision.nextState;
              }
              if (result.status === 'HOLD') {
                setSimSummary(`Skipped before simulation: ${result.refresh?.decision?.reasonCode ?? 'HOLD'}`);
              }

              setUi(
                buildUiModel({
                  config: {
                    policy: autopilotConfig.policy,
                    execution: {
                      slippageBpsCap: autopilotConfig.execution.slippageBpsCap,
                      quoteFreshnessMs: autopilotConfig.execution.quoteFreshnessSec * 1000,
                    },
                  },
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
