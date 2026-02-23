'use client';

import { useMemo, useState } from 'react';
import { buildShellUiState, evaluateRangeBreak } from '@clmm-autopilot/core';
import {
  buildExitTransaction,
  createConsoleNotificationAdapter,
  deriveReceiptPda,
  fetchReceiptByPda,
  loadSolanaConfig,
  loadPositionSnapshot,
  type CanonicalErrorCode,
  type PositionSnapshot,
} from '@clmm-autopilot/solana';
import { Buffer } from 'buffer';
import { Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';

type SolanaProvider = {
  isPhantom?: boolean;
  publicKey?: { toBase58: () => string };
  connect: () => Promise<void>;
  signAndSendTransaction: (tx: VersionedTransaction) => Promise<{ signature: string }>;
};

const errorMap: Record<CanonicalErrorCode, string> = {
  DATA_UNAVAILABLE: 'Data unavailable. Check position and RPC availability.',
  RPC_TRANSIENT: 'Temporary RPC issue. Retry shortly.',
  RPC_PERMANENT: 'Permanent RPC error. Check endpoint.',
  INVALID_POSITION: 'Invalid position address.',
  NOT_SOL_USDC: 'Position is not SOL/USDC.',
  ALREADY_EXECUTED_THIS_EPOCH: 'Already executed this epoch.',
  QUOTE_STALE: 'Quote stale. Rebuild failed in allowed window.',
  SIMULATION_FAILED: 'Simulation failed. Execution blocked.',
  SLIPPAGE_EXCEEDED: 'Slippage cap exceeded.',
  INSUFFICIENT_FEE_BUFFER: 'Insufficient fee buffer.',
  BLOCKHASH_EXPIRED: 'Blockhash expired. Refresh and retry.',
};

export default function Home() {
  const config = useMemo(() => loadSolanaConfig(process.env), []);
  const [wallet, setWallet] = useState<string>('');
  const [positionAddress, setPositionAddress] = useState<string>('');
  const [snapshot, setSnapshot] = useState<PositionSnapshot | null>(null);
  const [quoteAgeMs, setQuoteAgeMs] = useState<number>(0);
  const [expectedMinOut, setExpectedMinOut] = useState<string>('0');
  const [receiptPda, setReceiptPda] = useState<string>('');
  const [txSignature, setTxSignature] = useState<string>('');
  const [error, setError] = useState<string>('');

  const shellState = useMemo(() => {
    if (!snapshot) return null;
    const decision = evaluateRangeBreak(
      [
        { slot: 1, unixTs: 1_700_000_000, currentTickIndex: snapshot.currentTickIndex },
        { slot: 2, unixTs: 1_700_000_002, currentTickIndex: snapshot.currentTickIndex },
        { slot: 3, unixTs: 1_700_000_004, currentTickIndex: snapshot.currentTickIndex },
      ],
      { lowerTickIndex: snapshot.lowerTickIndex, upperTickIndex: snapshot.upperTickIndex },
      { requiredConsecutive: 3, cadenceMs: 2000, cooldownMs: 90_000 },
    );

    return buildShellUiState({
      decision,
      quote: { slippageCapBps: 50, expectedMinOut, quoteAgeMs },
      snapshot: {
        currentTickIndex: snapshot.currentTickIndex,
        lowerTickIndex: snapshot.lowerTickIndex,
        upperTickIndex: snapshot.upperTickIndex,
      },
    });
  }, [snapshot, expectedMinOut, quoteAgeMs]);

  const notification = useMemo(() => createConsoleNotificationAdapter(), []);

  return (
    <main className="p-6 font-sans space-y-4">
      <h1 className="text-2xl font-bold">CLMM Autopilot — M6 Shell UX</h1>
      <p className="text-sm text-gray-700">Monitor, confirm trigger readiness, and execute (Phase 1 signed flow).</p>

      <section className="space-y-2">
        <button
          className="rounded bg-black text-white px-3 py-2"
          onClick={async () => {
            setError('');
            try {
              const provider = (window as unknown as { solana?: SolanaProvider }).solana;
              if (!provider) throw new Error('No injected Solana wallet found');
              await provider.connect();
              const pubkey = provider.publicKey?.toBase58();
              if (!pubkey) throw new Error('Wallet did not expose public key');
              setWallet(pubkey);
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          {wallet ? 'Wallet Connected' : 'Connect Wallet'}
        </button>
        <div className="text-xs">{wallet || 'No wallet connected'}</div>
      </section>

      <section className="space-y-2">
        <input
          className="border rounded px-3 py-2 w-full"
          value={positionAddress}
          onChange={(e) => setPositionAddress(e.target.value)}
          placeholder="Orca position account"
        />
        <button
          className="rounded bg-blue-600 text-white px-3 py-2"
          onClick={async () => {
            setError('');
            try {
              const connection = new Connection(config.rpcUrl, config.commitment);
              const snap = await loadPositionSnapshot(connection, new PublicKey(positionAddress));
              setSnapshot(snap);
              setQuoteAgeMs(500);
              setExpectedMinOut('123456');
              notification.notify({ level: 'info', message: 'Snapshot loaded', context: { tick: snap.currentTickIndex } });
            } catch (e) {
              const c = e as { code?: CanonicalErrorCode; message?: string };
              setError(c.code ? `${errorMap[c.code]} (${c.code})` : String(e));
            }
          }}
        >
          Fetch snapshot + decision
        </button>
      </section>

      {shellState ? (
        <section className="text-sm space-y-1 border rounded p-3">
          <div>current tick: {shellState.snapshot.currentTickIndex}</div>
          <div>lower/upper ticks: {shellState.snapshot.lowerTickIndex} / {shellState.snapshot.upperTickIndex}</div>
          <div>decision: {shellState.decision}</div>
          <div>reason code: {shellState.reasonCode}</div>
          <div>debounce progress: {shellState.debounceProgress}</div>
          <div>cooldown remaining (ms): {shellState.cooldownRemainingMs}</div>
          <div>slippage cap (bps): {shellState.quote.slippageCapBps}</div>
          <div>expected minOut: {shellState.quote.expectedMinOut}</div>
          <div>quote age (ms): {shellState.quote.quoteAgeMs}</div>
          <button
            className="rounded bg-green-700 text-white px-3 py-2 disabled:opacity-40"
            disabled={!shellState.canExecute || !wallet}
            onClick={async () => {
              setError('');
              if (!snapshot) return;
              try {
                const authority = new PublicKey(wallet);
                const now = Date.now();
                const epoch = Math.floor(now / 1000 / 86400);
                const [receipt] = deriveReceiptPda({ authority, positionMint: snapshot.positionMint, epoch });
                setReceiptPda(receipt.toBase58());

                const connection = new Connection(config.rpcUrl, config.commitment);
                const latest = await connection.getLatestBlockhash();
                const inputMint = snapshot.tokenMintA.equals(new PublicKey('So11111111111111111111111111111111111111112'))
                  ? snapshot.tokenMintA
                  : snapshot.tokenMintB;
                const outputMint = inputMint.equals(snapshot.tokenMintA) ? snapshot.tokenMintB : snapshot.tokenMintA;

                const message = (await buildExitTransaction(
                  snapshot,
                  shellState?.decision === 'TRIGGER_UP' ? 'UP' : 'DOWN',
                  {
                    authority,
                    payer: authority,
                    recentBlockhash: latest.blockhash,
                    computeUnitLimit: 600000,
                    computeUnitPriceMicroLamports: 10000,
                    conditionalAtaIxs: [],
                    removeLiquidityIx: new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.from([1]) }),
                    collectFeesIx: new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.from([2]) }),
                    jupiterSwapIx: new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.from([3]) }),
                    buildWsolLifecycleIxs: () => ({
                      preSwap: [new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.from([4]) })],
                      postSwap: [new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.from([5]) })],
                    }),
                    quote: {
                      inputMint,
                      outputMint,
                      slippageBps: 50,
                      quotedAtUnixMs: now,
                    },
                    maxSlippageBps: 50,
                    quoteFreshnessMs: 2_000,
                    maxRebuildAttempts: 3,
                    nowUnixMs: () => now,
                    rebuildSnapshotAndQuote: async () => ({
                      snapshot,
                      quote: {
                        inputMint,
                        outputMint,
                        slippageBps: 50,
                        quotedAtUnixMs: now,
                      },
                    }),
                    availableLamports: 5_000_000,
                    estimatedNetworkFeeLamports: 20_000,
                    estimatedPriorityFeeLamports: 10_000,
                    estimatedRentLamports: 2_039_280,
                    estimatedAtaCreateLamports: 0,
                    feeBufferLamports: 10_000,
                    txSigHash: new Uint8Array(32).fill(9),
                    returnVersioned: true,
                    simulate: async (msg: TransactionMessage) => {
                      const simTx = new VersionedTransaction(msg.compileToV0Message([]));
                      const sim = await connection.simulateTransaction(simTx);
                      return { err: sim.value.err, accountsResolved: true };
                    },
                  },
                )) as VersionedTransaction;

                const provider = (window as unknown as { solana?: SolanaProvider }).solana;
                if (!provider) throw new Error('No injected Solana wallet found');
                const sent = await provider.signAndSendTransaction(message);
                setTxSignature(sent.signature);

                const receiptAccount = await fetchReceiptByPda(connection, receipt);
                if (!receiptAccount) throw new Error('Receipt account not found after send');
                notification.notify({ level: 'info', message: 'Execution sent', context: { signature: sent.signature } });
              } catch (e) {
                const c = e as { code?: CanonicalErrorCode };
                setError(c.code ? `${errorMap[c.code]} (${c.code})` : String(e));
              }
            }}
          >
            Execute
          </button>
        </section>
      ) : null}

      <section className="text-sm space-y-2">
        <div className="font-semibold">Confirmation</div>
        <div>receipt PDA: <span className="font-mono">{receiptPda || '—'}</span></div>
        <button className="underline" disabled={!receiptPda} onClick={() => navigator.clipboard.writeText(receiptPda)}>Copy receipt PDA</button>
        <div>tx signature: <span className="font-mono">{txSignature || '—'}</span></div>
        <button className="underline" disabled={!txSignature} onClick={() => navigator.clipboard.writeText(txSignature)}>Copy tx signature</button>
      </section>

      {error ? <div className="text-red-700 text-sm">{error}</div> : null}
    </main>
  );
}
