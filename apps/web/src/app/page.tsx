'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createConsoleNotificationsAdapter } from '@clmm-autopilot/notifications';
import { executeOnce, fetchJupiterQuote, loadPositionSnapshot, loadSolanaConfig, refreshPositionDecision } from '@clmm-autopilot/solana';
import { computeAttestationHash, encodeAttestationPayload, unixDaysFromUnixMs, type PolicyState } from '@clmm-autopilot/core';
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
  const policyStateRef = useRef<PolicyState>({});
  const [lastSimDebug, setLastSimDebug] = useState<unknown>(null);
  const [attestationDebugPrefix, setAttestationDebugPrefix] = useState<string>('N/A');
  const pollingRef = useRef<number | null>(null);

  const canExecute = Boolean(configValid && wallet && positionAddress && ui.canExecute);

  useEffect(() => {
    if (pollingRef.current) {
      window.clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
    setSamples([]);

    if (!positionAddress) return;

    const connection = new Connection(solanaConfig.rpcUrl, solanaConfig.commitment);
    let cancelled = false;

    const tick = async () => {
      try {
        const snapshot = await loadPositionSnapshot(connection, new PublicKey(positionAddress), solanaConfig.cluster);
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
  }, [positionAddress, solanaConfig.cluster, solanaConfig.commitment, solanaConfig.rpcUrl, autopilotConfig.policy.cadenceMs]);

  return (
    <main className="p-6 font-sans space-y-3">
      <h1 className="text-2xl font-bold">CLMM Autopilot — M6 Shell</h1>
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
        <div>maxSlippageBps: {autopilotConfig.execution.maxSlippageBps}</div>
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
                policyState: policyStateRef.current,
                expectedMinOut: 'N/A',
                quoteAgeMs: 0,
              });
              policyStateRef.current = refreshed.decision.nextState;
              setUi(buildUiModel({
                config: {
                  policy: autopilotConfig.policy,
                  execution: {
                    maxSlippageBps: autopilotConfig.execution.maxSlippageBps,
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

              // Build a quote off the current snapshot remove preview (best-effort Phase-1 heuristic).
              const snapshot = await loadPositionSnapshot(connection, position, solanaConfig.cluster);
              const dir = ui.decision?.decision === 'TRIGGER_UP' ? 'UP' : 'DOWN';
              if (!snapshot.removePreview) throw new Error(`Remove preview unavailable (${snapshot.removePreviewReasonCode ?? 'DATA_UNAVAILABLE'})`);

              const tokenAOut = snapshot.removePreview.tokenAOut;
              const tokenBOut = snapshot.removePreview.tokenBOut;

              const inputMint = dir === 'DOWN' ? SOL_MINT : (snapshot.tokenMintA.equals(SOL_MINT) ? snapshot.tokenMintB : snapshot.tokenMintA);
              const outputMint = dir === 'DOWN' ? (snapshot.tokenMintA.equals(SOL_MINT) ? snapshot.tokenMintB : snapshot.tokenMintA) : SOL_MINT;
              const amount = dir === 'DOWN'
                ? (snapshot.tokenMintA.equals(SOL_MINT) ? tokenAOut : tokenBOut)
                : (snapshot.tokenMintA.equals(SOL_MINT) ? tokenBOut : tokenAOut);

              const quote = await fetchJupiterQuote({ inputMint, outputMint, amount, slippageBps: autopilotConfig.execution.maxSlippageBps });
              const observedSlot = await connection.getSlot(solanaConfig.commitment);
              const epochNowMs = Date.now();
              const observedUnixTs = Math.floor(epochNowMs / 1000);
              const epoch = unixDaysFromUnixMs(epochNowMs);
              const attestationPayloadBytes = encodeAttestationPayload({
                authority: authority.toBase58(),
                positionMint: snapshot.positionMint.toBase58(),
                epoch,
                direction: dir === 'UP' ? 1 : 0,
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
                computeUnitLimit: autopilotConfig.execution.computeUnitLimit,
                computeUnitPriceMicroLamports: BigInt(autopilotConfig.execution.computeUnitPriceMicroLamports),
                maxSlippageBps: autopilotConfig.execution.maxSlippageBps,
                quoteFreshnessMs: BigInt(autopilotConfig.execution.quoteFreshnessMs),
                maxRebuildAttempts: autopilotConfig.execution.maxRebuildAttempts,
              });
              const attestationHash = computeAttestationHash({
                authority: authority.toBase58(),
                positionMint: snapshot.positionMint.toBase58(),
                epoch,
                direction: dir === 'UP' ? 1 : 0,
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
                computeUnitLimit: autopilotConfig.execution.computeUnitLimit,
                computeUnitPriceMicroLamports: BigInt(autopilotConfig.execution.computeUnitPriceMicroLamports),
                maxSlippageBps: autopilotConfig.execution.maxSlippageBps,
                quoteFreshnessMs: BigInt(autopilotConfig.execution.quoteFreshnessMs),
                maxRebuildAttempts: autopilotConfig.execution.maxRebuildAttempts,
              });
              setAttestationDebugPrefix(Buffer.from(attestationHash).toString('hex').slice(0, 12));

              const res = await executeOnce({
                connection,
                authority,
                position,
                samples,
                quote,
                config: autopilotConfig,
                policyState: policyStateRef.current,
                expectedMinOut: quote.outAmount.toString(),
                quoteAgeMs: Math.max(0, Date.now() - quote.quotedAtUnixMs),
                attestationHash,
                attestationPayloadBytes,
                onSimulationComplete: (s) => setSimSummary(`${s} — ready for wallet prompt`),
                signAndSend: async (tx: VersionedTransaction) => (await provider.signAndSendTransaction(tx)).signature,
                logger: notifications,
              });
              if (res.refresh?.decision?.nextState) {
                policyStateRef.current = res.refresh.decision.nextState;
              }

              setLastSimDebug(res.errorDebug ?? null);
              setUi(
                buildUiModel({
                  config: {
                    policy: autopilotConfig.policy,
                    execution: {
                      maxSlippageBps: autopilotConfig.execution.maxSlippageBps,
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
        <div>attestation hash (prefix): {attestationDebugPrefix}</div>
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

const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
