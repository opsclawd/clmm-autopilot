'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createConsoleNotificationsAdapter } from '@clmm-autopilot/notifications';
import { executeOnce, fetchJupiterQuote, loadPositionSnapshot, loadSolanaConfig, refreshPositionDecision } from '@clmm-autopilot/solana';
import { buildUiModel, mapErrorToUi, type UiModel } from '@clmm-autopilot/ui-state';
import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';

type WalletProvider = {
  connect: () => Promise<void>;
  publicKey?: { toBase58: () => string };
  signAndSendTransaction: (tx: VersionedTransaction) => Promise<{ signature: string }>;
};

type Sample = { slot: number; unixTs: number; currentTickIndex: number };

export default function Home() {
  const config = loadSolanaConfig(process.env);
  const notifications = useMemo(() => createConsoleNotificationsAdapter(), []);
  const [positionAddress, setPositionAddress] = useState('');
  const [wallet, setWallet] = useState('');
  const [ui, setUi] = useState<UiModel>(buildUiModel({}));
  const [simSummary, setSimSummary] = useState<string>('N/A');
  const [samples, setSamples] = useState<Sample[]>([]);
  const [lastSimDebug, setLastSimDebug] = useState<unknown>(null);
  const pollingRef = useRef<number | null>(null);

  const canExecute = Boolean(wallet && positionAddress && ui.decision?.decision !== 'HOLD');

  useEffect(() => {
    if (pollingRef.current) {
      window.clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
    setSamples([]);

    if (!positionAddress) return;

    const connection = new Connection(config.rpcUrl, config.commitment);
    let cancelled = false;

    const tick = async () => {
      try {
        const snapshot = await loadPositionSnapshot(connection, new PublicKey(positionAddress));
        const slot = await connection.getSlot(config.commitment);
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
    pollingRef.current = window.setInterval(() => void tick(), 2000);

    return () => {
      cancelled = true;
      if (pollingRef.current) {
        window.clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [positionAddress, config.commitment, config.rpcUrl]);

  return (
    <main className="p-6 font-sans space-y-3">
      <h1 className="text-2xl font-bold">CLMM Autopilot — M6 Shell</h1>
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
          disabled={!positionAddress}
          onClick={async () => {
            try {
              const connection = new Connection(config.rpcUrl, config.commitment);
              const refreshed = await refreshPositionDecision({
                connection,
                position: new PublicKey(positionAddress),
                samples,
                slippageBpsCap: 50,
                expectedMinOut: 'N/A',
                quoteAgeMs: 0,
              });
              setUi(buildUiModel({ snapshot: refreshed.snapshot, decision: refreshed.decision, quote: refreshed.quote }));
            } catch (e) {
              const mapped = mapErrorToUi(e);
              setUi(buildUiModel({ lastError: `${mapped.code}: ${mapped.message}` }));
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
              const connection = new Connection(config.rpcUrl, config.commitment);

              // Build a quote off the current snapshot remove preview (best-effort Phase-1 heuristic).
              const snapshot = await loadPositionSnapshot(connection, position);
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

              const res = await executeOnce({
                connection,
                authority,
                position,
                samples,
                quote,
                slippageBpsCap: 50,
                expectedMinOut: quote.outAmount.toString(),
                quoteAgeMs: 0,
                attestationHash: new Uint8Array(32),
                onSimulationComplete: (s) => setSimSummary(`${s} — ready for wallet prompt`),
                signAndSend: async (tx: VersionedTransaction) => (await provider.signAndSendTransaction(tx)).signature,
                logger: notifications,
              });

              setLastSimDebug(res.errorDebug ?? null);
              setUi(
                buildUiModel({
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

const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
