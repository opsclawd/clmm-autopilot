'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createConsoleNotificationsAdapter } from '@clmm-autopilot/notifications';
import { executeOnce, loadPositionSnapshot, loadSolanaConfig, refreshPositionDecision } from '@clmm-autopilot/solana';
import { type PolicyState } from '@clmm-autopilot/core';
import { loadAutopilotConfig } from '../config';
import { buildUiModel, mapErrorToUi, type UiModel } from '@clmm-autopilot/ui-state';
import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';

type WalletProvider = {
  connect: () => Promise<void>;
  publicKey?: { toBase58: () => string };
  signAndSendTransaction: (tx: VersionedTransaction) => Promise<{ signature: string }>;
};

type Sample = { slot: number; unixTs: number; currentTickIndex: number };

export default function Home() {
  const solanaConfig = loadSolanaConfig(process.env);
  const loaded = useMemo(() => loadAutopilotConfig(process.env), []);
  const autopilotConfig = loaded.config;
  const configValid = loaded.ok;
  const notifications = useMemo(() => createConsoleNotificationsAdapter(), []);
  const [positionAddress, setPositionAddress] = useState('');
  const [wallet, setWallet] = useState('');
  const [ui, setUi] = useState<UiModel>(buildUiModel({}));
  const [simSummary, setSimSummary] = useState<string>('N/A');
  const [samples, setSamples] = useState<Sample[]>([]);
  const previewPolicyStateRef = useRef<PolicyState>({});
  const executionPolicyStateRef = useRef<PolicyState>({});
  const [lastSimDebug, setLastSimDebug] = useState<unknown>(null);
  const pollingRef = useRef<number | null>(null);

  const canExecute = Boolean(configValid && wallet && positionAddress && ui.canExecute);

  useEffect(() => {
    if (pollingRef.current) {
      window.clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
    setSamples([]);
    previewPolicyStateRef.current = {};
    executionPolicyStateRef.current = {};

    if (!positionAddress) return;

    const connection = new Connection(solanaConfig.rpcUrl, solanaConfig.commitment);
    let cancelled = false;

    const tick = async () => {
      try {
        const snapshot = await loadPositionSnapshot(connection, new PublicKey(positionAddress), autopilotConfig.cluster);
        const slot = await connection.getSlot(solanaConfig.commitment);
        const unixTs = Math.floor(Date.now() / 1000);
        if (cancelled) return;
        setSamples((prev) => {
          const next = [...prev, { slot, unixTs, currentTickIndex: snapshot.currentTickIndex }];
          return next.slice(-90); // rolling window (~3 min @2s cadence)
        });
      } catch {
        // silence polling errors; refresh button surface errors deterministically.
      }
    };

    void tick();
    pollingRef.current = window.setInterval(() => void tick(), autopilotConfig.policy.cadenceMs);

    return () => {
      cancelled = true;
      if (pollingRef.current) {
        window.clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [positionAddress, autopilotConfig.cluster, solanaConfig.commitment, solanaConfig.rpcUrl, autopilotConfig.policy.cadenceMs]);

  return (
    <main className="p-6 font-sans space-y-3">
      <h1 className="text-2xl font-bold">CLMM Autopilot — Shell</h1>
      {!configValid ? (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm">
          <div className="font-semibold">{mapErrorToUi({ code: 'CONFIG_INVALID' }).title}</div>
          <div className="mb-1">{mapErrorToUi({ code: 'CONFIG_INVALID' }).message}</div>
          <ul className="list-disc pl-5">
            {loaded.ok ? null : loaded.errors.map((e) => (
              <li key={`${e.path}:${e.code}`}>
                {e.path}: {e.message} {e.expected ? `(expected ${e.expected})` : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="rounded border p-3 text-sm">
        <div className="font-semibold mb-1">Config</div>
        <div>cadenceMs: {autopilotConfig.policy.cadenceMs}</div>
        <div>requiredConsecutive: {autopilotConfig.policy.requiredConsecutive}</div>
        <div>cooldownMs: {autopilotConfig.policy.cooldownMs}</div>
        <div>slippageBpsCap: {autopilotConfig.execution.slippageBpsCap}</div>
        <div>quoteFreshnessMs: {autopilotConfig.execution.quoteFreshnessMs}</div>
      </div>
      <div className="flex gap-2">
        <button
          className="rounded bg-black text-white px-3 py-2"
          onClick={async () => {
            const provider = (window as Window & { solana?: WalletProvider }).solana;
            if (!provider) return;
            await provider.connect();
            setWallet(provider.publicKey?.toBase58() ?? '');
          }}
        >
          Connect Wallet
        </button>
        <button className="rounded border px-3 py-2" onClick={() => setWallet('')} disabled={!wallet}>
          Disconnect
        </button>
      </div>

      <input
        className="border rounded px-3 py-2 w-full"
        value={positionAddress}
        onChange={(e) => setPositionAddress(e.target.value)}
        placeholder="Orca position account"
      />

      <div className="flex gap-2">
        <button
          className="rounded bg-gray-800 text-white px-3 py-2"
          disabled={!configValid || !positionAddress}
          onClick={async () => {
            try {
              const connection = new Connection(solanaConfig.rpcUrl, solanaConfig.commitment);
              const refreshed = await refreshPositionDecision({
                connection,
                position: new PublicKey(positionAddress),
                samples,
                config: autopilotConfig,
                policyState: previewPolicyStateRef.current,
                expectedMinOut: 'N/A',
                quoteAgeMs: 0,
              });
              previewPolicyStateRef.current = refreshed.decision.nextState;
              setUi(buildUiModel({
                config: {
                  policy: autopilotConfig.policy,
                  execution: {
                    slippageBpsCap: autopilotConfig.execution.slippageBpsCap,
                    quoteFreshnessMs: autopilotConfig.execution.quoteFreshnessMs,
                  },
                },
                snapshot: refreshed.snapshot,
                decision: refreshed.decision,
                quote: refreshed.quote,
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
        >
          Refresh
        </button>

        <button
          className="rounded bg-blue-600 text-white px-3 py-2 disabled:bg-gray-300"
          disabled={!canExecute}
          onClick={async () => {
            try {
              const provider = (window as Window & { solana?: WalletProvider }).solana;
              if (!provider) throw new Error('Wallet provider unavailable');
              const authority = new PublicKey(wallet);
              const position = new PublicKey(positionAddress);
              const connection = new Connection(solanaConfig.rpcUrl, solanaConfig.commitment);

              const res = await executeOnce({
                connection,
                authority,
                position,
                samples,
                config: autopilotConfig,
                policyState: executionPolicyStateRef.current,
                expectedMinOut: 'N/A',
                quoteAgeMs: 0,
                onSimulationComplete: (s) => setSimSummary(`${s} — ready for wallet prompt`),
                signAndSend: async (tx: VersionedTransaction) => (await provider.signAndSendTransaction(tx)).signature,
                logger: notifications,
              });
              if (res.refresh?.decision?.nextState) {
                executionPolicyStateRef.current = res.refresh.decision.nextState;
                previewPolicyStateRef.current = res.refresh.decision.nextState;
              }
              if (res.status === 'HOLD') {
                setSimSummary(`Skipped before simulation: ${res.refresh?.decision?.reasonCode ?? 'HOLD'}`);
              }

              setLastSimDebug(res.errorDebug ?? null);
              setUi(
                buildUiModel({
                  config: {
                    policy: autopilotConfig.policy,
                    execution: {
                      slippageBpsCap: autopilotConfig.execution.slippageBpsCap,
                      quoteFreshnessMs: autopilotConfig.execution.quoteFreshnessMs,
                    },
                  },
                  snapshot: res.refresh?.snapshot,
                  decision: res.refresh?.decision,
                  quote: res.refresh?.quote,
                  execution: res.execution,
                  lastError:
                    res.status === 'ERROR' && res.errorCode
                      ? (() => {
                          const mapped = mapErrorToUi({ code: res.errorCode, debug: res.errorDebug, message: res.errorMessage });
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
        >
          Execute
        </button>
      </div>

      <section className="text-sm space-y-1 border rounded p-3">
        <div>current tick: {ui.snapshot?.currentTick ?? 'N/A'}</div>
        <div>lower tick: {ui.snapshot?.lowerTick ?? 'N/A'}</div>
        <div>upper tick: {ui.snapshot?.upperTick ?? 'N/A'}</div>
        <div>decision: {ui.decision?.decision ?? 'N/A'}</div>
        <div>reasonCode: {ui.decision?.reasonCode ?? 'N/A'}</div>
        <div>debounce progress: {ui.decision ? `${ui.decision.samplesUsed}/${ui.decision.threshold}` : 'N/A'}</div>
        <div>pending confirm: {ui.decision && ui.decision.samplesUsed < ui.decision.threshold ? 'yes' : 'no'}</div>
        <div>cooldown remaining (ms): {ui.decision?.cooldownRemainingMs ?? 'N/A'}</div>
        <div>slippage cap: {ui.quote?.slippageBpsCap ?? 'N/A'}</div>
        <div>expected minOut: {ui.quote?.expectedMinOut ?? 'N/A'}</div>
        <div>quote age (ms): {ui.quote?.quoteAgeMs ?? 'N/A'}</div>
        <div>pair: {ui.snapshot?.pairLabel ?? 'N/A'}</div>
        <div>pair valid: {ui.snapshot?.pairValid === undefined ? 'N/A' : ui.snapshot?.pairValid ? 'yes' : 'no'}</div>
        <div>samples buffered: {samples.length}</div>
        <div>simulate summary: {simSummary}</div>
      </section>

      <section className="text-sm space-y-1 border rounded p-3">
        <div>tx signature: {ui.execution?.sendSig ?? 'N/A'}</div>
        <button
          className="underline"
          disabled={!ui.execution?.sendSig}
          onClick={() => navigator.clipboard.writeText(ui.execution?.sendSig ?? '')}
        >
          Copy tx signature
        </button>
        <div>receipt PDA: {ui.execution?.receiptPda ?? 'N/A'}</div>
        <button
          className="underline"
          disabled={!ui.execution?.receiptPda}
          onClick={() => navigator.clipboard.writeText(ui.execution?.receiptPda ?? '')}
        >
          Copy receipt PDA
        </button>
        <div>receipt fields: {ui.execution?.receiptFields ?? 'N/A'}</div>
      </section>

      {ui.lastError ? <div className="text-red-700 text-sm">{ui.lastError}</div> : null}
      {process.env.NODE_ENV !== 'production' && ui.lastError && lastSimDebug ? (
        <details className="text-xs border rounded p-3">
          <summary className="cursor-pointer font-semibold">Sim logs (dev)</summary>
          <pre className="whitespace-pre-wrap break-all mt-2">{JSON.stringify(lastSimDebug, null, 2)}</pre>
        </details>
      ) : null}
    </main>
  );
}
