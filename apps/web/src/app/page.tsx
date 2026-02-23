'use client';

import { useState } from 'react';
import { Connection, PublicKey, SystemProgram, VersionedTransaction } from '@solana/web3.js';
import { executeOnce, loadSolanaConfig } from '@clmm-autopilot/solana';
import { buildUiModel, mapErrorToUi, type UiModel } from '@clmm-autopilot/ui-state';

export default function Home() {
  const config = loadSolanaConfig(process.env);
  const [positionAddress, setPositionAddress] = useState('');
  const [wallet, setWallet] = useState('');
  const [ui, setUi] = useState<UiModel>(buildUiModel({}));

  return (
    <main className="p-6 font-sans space-y-3">
      <h1 className="text-2xl font-bold">CLMM Autopilot — M6 Shell UX</h1>
      <button
        className="rounded bg-black text-white px-3 py-2"
        onClick={async () => {
          try {
            const provider = (window as unknown as { solana?: { connect: () => Promise<void>; publicKey?: { toBase58: () => string }; signAndSendTransaction: (tx: VersionedTransaction) => Promise<{ signature: string }> } }).solana;
            if (!provider) throw new Error('Wallet provider unavailable');
            await provider.connect();
            setWallet(provider.publicKey?.toBase58() ?? '');
          } catch (e) {
            const mapped = mapErrorToUi(e);
            setUi(buildUiModel({ ...ui, lastError: `${mapped.code}: ${mapped.message}` }));
          }
        }}
      >
        {wallet ? 'Wallet Connected' : 'Connect Wallet'}
      </button>

      <input
        className="border rounded px-3 py-2 w-full"
        value={positionAddress}
        onChange={(e) => setPositionAddress(e.target.value)}
        placeholder="Orca position account"
      />

      <button
        className="rounded bg-blue-600 text-white px-3 py-2"
        disabled={!wallet || !positionAddress}
        onClick={async () => {
          try {
            const provider = (window as unknown as { solana?: { signAndSendTransaction: (tx: VersionedTransaction) => Promise<{ signature: string }> } }).solana;
            if (!provider) throw new Error('Wallet provider unavailable');
            const authority = new PublicKey(wallet);
            const position = new PublicKey(positionAddress);
            const connection = new Connection(config.rpcUrl, config.commitment);
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
              signAndSend: async (tx) => (await provider.signAndSendTransaction(tx)).signature,
            });
            setUi(result.ui);
          } catch (e) {
            const mapped = mapErrorToUi(e);
            setUi(buildUiModel({ ...ui, lastError: `${mapped.code}: ${mapped.message}` }));
          }
        }}
      >
        Execute
      </button>

      <section className="text-sm space-y-1 border rounded p-3">
        <div>current tick: {ui.snapshot?.currentTick ?? 'N/A'}</div>
        <div>lower tick: {ui.snapshot?.lowerTick ?? 'N/A'}</div>
        <div>upper tick: {ui.snapshot?.upperTick ?? 'N/A'}</div>
        <div>decision: {ui.decision?.decision ?? 'N/A'}</div>
        <div>reasonCode: {ui.decision?.reasonCode ?? 'N/A'}</div>
        <div>debounce progress: {ui.decision ? `${ui.decision.samplesUsed}/${ui.decision.threshold}` : 'N/A'}</div>
        <div>cooldown remaining (ms): {ui.decision?.cooldownRemainingMs ?? 'N/A'}</div>
        <div>slippage cap: {ui.quote?.slippageBpsCap ?? 'N/A'}</div>
        <div>expected minOut: {ui.quote?.expectedMinOut ?? 'N/A'}</div>
        <div>quote age (ms): {ui.quote?.quoteAgeMs ?? 'N/A'}</div>
      </section>

      <section className="text-sm space-y-1 border rounded p-3">
        <div>receipt PDA: {ui.execution?.receiptPda ?? 'N/A'}</div>
        <button className="underline" disabled={!ui.execution?.receiptPda} onClick={() => navigator.clipboard.writeText(ui.execution?.receiptPda ?? '')}>Copy receipt PDA</button>
        <div>tx signature: {ui.execution?.sendSig ?? 'N/A'}</div>
        <button className="underline" disabled={!ui.execution?.sendSig} onClick={() => navigator.clipboard.writeText(ui.execution?.sendSig ?? '')}>Copy tx signature</button>
        <div>receipt fields: {ui.execution?.receiptFields ?? 'N/A'}</div>
      </section>

      {ui.lastError ? <div className="text-red-700 text-sm">{ui.lastError}</div> : null}
    </main>
  );
}
