import { StatusBar } from 'expo-status-bar';
import * as Clipboard from 'expo-clipboard';
import { useMemo, useState } from 'react';
import { Button, SafeAreaView, ScrollView, Text, TextInput, View } from 'react-native';
import { buildShellUiState, evaluateRangeBreak } from '@clmm-autopilot/core';
import {
  buildExitTransaction,
  deriveReceiptPda,
  fetchReceiptByPda,
  loadPositionSnapshot,
  type CanonicalErrorCode,
  type PositionSnapshot,
} from '@clmm-autopilot/solana';
import { Buffer } from 'buffer';
import { sha256 } from '@noble/hashes/sha256';
import { Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { runMwaSignAndSendVersionedTransaction, runMwaSignMessageSmoke } from './src/mwaSmoke';

const errorMap: Record<CanonicalErrorCode, string> = {
  DATA_UNAVAILABLE: 'Data unavailable.',
  RPC_TRANSIENT: 'RPC transient.',
  RPC_PERMANENT: 'RPC permanent failure.',
  INVALID_POSITION: 'Invalid position.',
  NOT_SOL_USDC: 'Not SOL/USDC.',
  ALREADY_EXECUTED_THIS_EPOCH: 'Already executed this epoch.',
  QUOTE_STALE: 'Quote stale.',
  SIMULATION_FAILED: 'Simulation failed.',
  SLIPPAGE_EXCEEDED: 'Slippage exceeded.',
  INSUFFICIENT_FEE_BUFFER: 'Insufficient fee buffer.',
  BLOCKHASH_EXPIRED: 'Blockhash expired.',
};

export default function App() {
  const [wallet, setWallet] = useState<string>('');
  const [positionAddress, setPositionAddress] = useState('');
  const [snapshot, setSnapshot] = useState<PositionSnapshot | null>(null);
  const [receiptPda, setReceiptPda] = useState('');
  const [receiptFields, setReceiptFields] = useState('');
  const [signature, setSignature] = useState('');
  const [txSigHashHex, setTxSigHashHex] = useState('');
  const [error, setError] = useState('');

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
      quote: { slippageCapBps: 50, expectedMinOut: '123456', quoteAgeMs: 500 },
      snapshot: {
        currentTickIndex: snapshot.currentTickIndex,
        lowerTickIndex: snapshot.lowerTickIndex,
        upperTickIndex: snapshot.upperTickIndex,
      },
    });
  }, [snapshot]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#fff' }}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        <Text style={{ fontSize: 22, fontWeight: '700' }}>M6 Mobile Shell UX</Text>
        <Text>Monitor, confirm trigger readiness, execute (user signed flow).</Text>

        <Button
          title={wallet ? 'Wallet Connected' : 'Connect Wallet (MWA)'}
          onPress={async () => {
            setError('');
            try {
              const result = await runMwaSignMessageSmoke();
              setWallet(result.publicKey);
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          }}
        />
        <Text selectable>{wallet || 'No wallet connected'}</Text>

        <TextInput
          placeholder="Orca position account"
          value={positionAddress}
          onChangeText={setPositionAddress}
          style={{ borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 10 }}
          autoCapitalize="none"
          autoCorrect={false}
        />


        <Button
          title="Fetch snapshot + decision"
          onPress={async () => {
            setError('');
            try {
              const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
              const snap = await loadPositionSnapshot(connection, new PublicKey(positionAddress));
              setSnapshot(snap);
            } catch (e) {
              const c = e as { code?: CanonicalErrorCode };
              setError(c.code ? `${errorMap[c.code]} (${c.code})` : String(e));
            }
          }}
        />

        {shellState ? (
          <View style={{ gap: 6 }}>
            <Text>current tick: {shellState.snapshot.currentTickIndex}</Text>
            <Text>lower/upper: {shellState.snapshot.lowerTickIndex} / {shellState.snapshot.upperTickIndex}</Text>
            <Text>decision: {shellState.decision}</Text>
            <Text>reason: {shellState.reasonCode}</Text>
            <Text>debounce: {shellState.debounceProgress}</Text>
            <Text>cooldown ms: {shellState.cooldownRemainingMs}</Text>
            <Text>slippage cap bps: {shellState.quote.slippageCapBps}</Text>
            <Text>expected minOut: {shellState.quote.expectedMinOut}</Text>
            <Text>quote age ms: {shellState.quote.quoteAgeMs}</Text>

            <Button
              title="Execute"
              disabled={!shellState.canExecute || !wallet}
              onPress={async () => {
                setError('');
                if (!snapshot) return;

                try {
                  const authority = new PublicKey(wallet);
                  const now = Date.now();
                  const epoch = Math.floor(now / 1000 / 86400);
                  const [receipt] = deriveReceiptPda({ authority, positionMint: snapshot.positionMint, epoch });
                  setReceiptPda(receipt.toBase58());

                  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
                  const latest = await connection.getLatestBlockhash();
                  const inputMint = snapshot.tokenMintA.equals(new PublicKey('So11111111111111111111111111111111111111112')) ? snapshot.tokenMintA : snapshot.tokenMintB;
                  const outputMint = inputMint.equals(snapshot.tokenMintA) ? snapshot.tokenMintB : snapshot.tokenMintA;

                  const txSigHashBytes = new Uint8Array(32);

                  const message = (await buildExitTransaction(snapshot, shellState.decision === 'TRIGGER_UP' ? 'UP' : 'DOWN', {
                    authority,
                    payer: authority,
                    recentBlockhash: latest.blockhash,
                    computeUnitLimit: 600000,
                    computeUnitPriceMicroLamports: 10000,
                    conditionalAtaIxs: [],
                    removeLiquidityIx: SystemProgram.transfer({ fromPubkey: authority, toPubkey: authority, lamports: 0 }),
                    collectFeesIx: SystemProgram.transfer({ fromPubkey: authority, toPubkey: authority, lamports: 0 }),
                    jupiterSwapIx: SystemProgram.transfer({ fromPubkey: authority, toPubkey: authority, lamports: 0 }),
                    buildWsolLifecycleIxs: () => ({
                      preSwap: [SystemProgram.transfer({ fromPubkey: authority, toPubkey: authority, lamports: 0 })],
                      postSwap: [SystemProgram.transfer({ fromPubkey: authority, toPubkey: authority, lamports: 0 })],
                    }),
                    quote: {
                      inputMint,
                      outputMint,
                      slippageBps: 50,
                      quotedAtUnixMs: now,
                    },
                    maxSlippageBps: 50,
                    quoteFreshnessMs: 2000,
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
                    txSigHash: txSigHashBytes,
                    returnVersioned: true,
                    simulate: async (msg: TransactionMessage) => {
                      const simTx = new VersionedTransaction(msg.compileToV0Message([]));
                      const sim = await connection.simulateTransaction(simTx);
                      return { err: sim.value.err, accountsResolved: true };
                    },
                  })) as VersionedTransaction;

                  const sent = await runMwaSignAndSendVersionedTransaction(message);
                  setSignature(sent.signature);
                  const sigHash = sha256(new TextEncoder().encode(sent.signature));
                  setTxSigHashHex(Buffer.from(sigHash).toString('hex'));

                  const receiptAccount = await fetchReceiptByPda(connection, receipt);
                  if (!receiptAccount) throw new Error('Receipt account not found after send');
                  setReceiptFields(
                    `authority=${receiptAccount.authority.toBase58()} positionMint=${receiptAccount.positionMint.toBase58()} epoch=${receiptAccount.epoch} direction=${receiptAccount.direction} txSigHash=${Buffer.from(receiptAccount.txSigHash).toString('hex')} slot=${receiptAccount.slot.toString()} unixTs=${receiptAccount.unixTs.toString()} bump=${receiptAccount.bump}`,
                  );
                } catch (e) {
                  const c = e as { code?: CanonicalErrorCode };
                  setError(c.code ? `${errorMap[c.code]} (${c.code})` : String(e));
                }
              }}
            />
          </View>
        ) : null}

        <View style={{ gap: 6 }}>
          <Text>receipt PDA</Text>
          <Text selectable>{receiptPda || '—'}</Text>
          <Button title="Copy receipt PDA" disabled={!receiptPda} onPress={() => Clipboard.setStringAsync(receiptPda)} />

          <Text>tx signature</Text>
          <Text selectable>{signature || '—'}</Text>
          <Button title="Copy tx signature" disabled={!signature} onPress={() => Clipboard.setStringAsync(signature)} />
          <Text>txSigHash (sha256(signature))</Text>
          <Text selectable>{txSigHashHex || '—'}</Text>
          <Text>receipt fields</Text>
          <Text selectable>{receiptFields || '—'}</Text>
        </View>

        {error ? <Text style={{ color: 'red' }}>{error}</Text> : null}
      </ScrollView>
      <StatusBar style="auto" />
    </SafeAreaView>
  );
}
