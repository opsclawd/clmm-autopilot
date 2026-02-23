'use client';

import { useMemo, useState } from 'react';
import { createConsoleNotificationsAdapter } from '@clmm-autopilot/notifications';
import { executeOnce, loadSolanaConfig, refreshPositionDecision } from '@clmm-autopilot/solana';
import { buildUiModel, mapErrorToUi, type UiModel } from '@clmm-autopilot/ui-state';
import { Connection, PublicKey, SystemProgram, VersionedTransaction } from '@solana/web3.js';

type WalletProvider = {
  connect: () => Promise<void>;
  publicKey?: { toBase58: () => string };
  signAndSendTransaction: (tx: VersionedTransaction) => Promise<{ signature: string }>;
};

export default function Home() {
  const config = loadSolanaConfig(process.env);
  const notifications = useMemo(() => createConsoleNotificationsAdapter(), []);
  const [positionAddress, setPositionAddress] = useState('');
  const [wallet, setWallet] = useState('');
  const [ui, setUi] = useState<UiModel>(buildUiModel({}));
  const [simSummary, setSimSummary] = useState<string>('N/A');

  const canExecute = Boolean(wallet && positionAddress && ui.decision?.decision !== 'HOLD');

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
        >Connect Wallet</button>
        <button className="rounded border px-3 py-2" onClick={() => setWallet('')} disabled={!wallet}>Disconnect</button>
      </div>

      <input className="border rounded px-3 py-2 w-full" value={positionAddress} onChange={(e) => setPositionAddress(e.target.value)} placeholder="Orca position account" />

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
                samples: [
                  { slot: 1, unixTs: 1_700_000_000, currentTickIndex: 0 },
                  { slot: 2, unixTs: 1_700_000_002, currentTickIndex: 0 },
                  { slot: 3, unixTs: 1_700_000_004, currentTickIndex: 0 },
                ],
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
        >Refresh</button>

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
              const res = await executeOnce({
                connection,
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
                signAndSend: async (tx: VersionedTransaction) => (await provider.signAndSendTransaction(tx)).signature,
                logger: notifications,
              });
              setUi(
                buildUiModel({
                  snapshot: res.refresh?.snapshot,
                  decision: res.refresh?.decision,
                  quote: res.refresh?.quote,
                  execution: res.execution,
                  lastError: res.errorCode ? `${res.errorCode}: ${res.errorMessage ?? ''}` : undefined,
                }),
              );
            } catch (e) {
              const mapped = mapErrorToUi(e);
              setUi(buildUiModel({ lastError: `${mapped.code}: ${mapped.message}` }));
            }
          }}
        >Execute</button>
      </div>

      <section className="text-sm space-y-1 border rounded p-3">
        <div>current tick: {ui.snapshot?.currentTick ?? 'N/A'}</div><div>lower tick: {ui.snapshot?.lowerTick ?? 'N/A'}</div><div>upper tick: {ui.snapshot?.upperTick ?? 'N/A'}</div>
        <div>decision: {ui.decision?.decision ?? 'N/A'}</div><div>reasonCode: {ui.decision?.reasonCode ?? 'N/A'}</div>
        <div>debounce progress: {ui.decision ? `${ui.decision.samplesUsed}/${ui.decision.threshold}` : 'N/A'}</div>
        <div>pending confirm: {ui.decision && ui.decision.samplesUsed < ui.decision.threshold ? 'yes' : 'no'}</div>
        <div>cooldown remaining (ms): {ui.decision?.cooldownRemainingMs ?? 'N/A'}</div>
        <div>slippage cap: {ui.quote?.slippageBpsCap ?? 'N/A'}</div><div>expected minOut: {ui.quote?.expectedMinOut ?? 'N/A'}</div><div>quote age (ms): {ui.quote?.quoteAgeMs ?? 'N/A'}</div>
        <div>simulate summary: {simSummary}</div>
      </section>

      <section className="text-sm space-y-1 border rounded p-3">
        <div>tx signature: {ui.execution?.sendSig ?? 'N/A'}</div>
        <button className="underline" disabled={!ui.execution?.sendSig} onClick={() => navigator.clipboard.writeText(ui.execution?.sendSig ?? '')}>Copy tx signature</button>
        <div>receipt PDA: {ui.execution?.receiptPda ?? 'N/A'}</div>
        <button className="underline" disabled={!ui.execution?.receiptPda} onClick={() => navigator.clipboard.writeText(ui.execution?.receiptPda ?? '')}>Copy receipt PDA</button>
        <div>receipt fields: {ui.execution?.receiptFields ?? 'N/A'}</div>
      </section>

      {ui.lastError ? <div className="text-red-700 text-sm">{ui.lastError}</div> : null}
    </main>
  );
}
