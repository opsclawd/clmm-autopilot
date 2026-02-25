import {
  DEFAULT_CONFIG,
  assertSolUsdcPair,
  computeAttestationHash,
  decideSwap,
  encodeAttestationPayload,
  evaluateRangeBreak,
  unixDaysFromUnixTs,
  type AutopilotConfig,
  type Sample,
} from '@clmm-autopilot/core';
import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { executeOnce } from './executeOnce';
import { fetchJupiterQuote } from './jupiter';
import { loadPositionSnapshot, type PositionSnapshot } from './orcaInspector';
import { deriveReceiptPda, fetchReceiptByPda, type ReceiptAccount } from './receipt';

export type HarnessDecision = 'HOLD' | 'TRIGGER_DOWN' | 'TRIGGER_UP';

type HarnessEnv = Record<string, string | undefined>;

type HarnessLogger = (entry: Record<string, unknown>) => void;

type HarnessDeps = {
  loadPositionSnapshot: typeof loadPositionSnapshot;
  fetchJupiterQuote: typeof fetchJupiterQuote;
  executeOnce: typeof executeOnce;
  fetchReceiptByPda: typeof fetchReceiptByPda;
  getSlot: (connection: Connection) => Promise<number>;
  nowMs: () => number;
};

const defaultDeps: HarnessDeps = {
  loadPositionSnapshot,
  fetchJupiterQuote,
  executeOnce,
  fetchReceiptByPda,
  getSlot: (connection) => connection.getSlot('confirmed'),
  nowMs: () => Date.now(),
};

function log(logger: HarnessLogger, step: string, fields: Record<string, unknown> = {}): void {
  logger({ ts: new Date().toISOString(), step, ...fields });
}

function parseRequiredEnv(env: HarnessEnv, key: 'RPC_URL' | 'AUTHORITY_KEYPAIR' | 'POSITION_ADDRESS'): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing required env: ${key}`);
  return value;
}

function parseAuthority(secretKeyJson: string): Keypair {
  let raw: unknown;
  try {
    raw = JSON.parse(secretKeyJson);
  } catch {
    throw new Error('AUTHORITY_KEYPAIR must point to a JSON keypair file (u8 array)');
  }
  if (!Array.isArray(raw)) throw new Error('AUTHORITY_KEYPAIR file must contain a JSON array');
  const bytes = Uint8Array.from(raw.map((v) => Number(v)));
  return Keypair.fromSecretKey(bytes);
}

async function loadAuthorityFromPath(path: string): Promise<Keypair> {
  const fs = await import('node:fs/promises');
  return parseAuthority(await fs.readFile(path, 'utf8'));
}

function buildSamples(currentTickIndex: number, unixTs: number, latestSlot: number): Sample[] {
  return [
    { slot: latestSlot - 2, unixTs: unixTs - 4, currentTickIndex },
    { slot: latestSlot - 1, unixTs: unixTs - 2, currentTickIndex },
    { slot: latestSlot, unixTs, currentTickIndex },
  ];
}

function decideDirection(decision: HarnessDecision): 0 | 1 {
  return decision === 'TRIGGER_UP' ? 1 : 0;
}

function getQuoteMintsAndAmount(snapshot: PositionSnapshot, decision: Exclude<HarnessDecision, 'HOLD'>): {
  inputMint: PublicKey;
  outputMint: PublicKey;
  amount: bigint;
  direction: 'DOWN' | 'UP';
} {
  if (!snapshot.removePreview) {
    throw Object.assign(new Error('Remove preview unavailable for quote sizing'), { code: 'DATA_UNAVAILABLE' });
  }

  const aIsSol = snapshot.tokenMintA.toBase58() === 'So11111111111111111111111111111111111111112';
  const direction = decision === 'TRIGGER_UP' ? 'UP' : 'DOWN';

  if (direction === 'DOWN') {
    return {
      direction,
      inputMint: aIsSol ? snapshot.tokenMintA : snapshot.tokenMintB,
      outputMint: aIsSol ? snapshot.tokenMintB : snapshot.tokenMintA,
      amount: aIsSol ? snapshot.removePreview.tokenAOut : snapshot.removePreview.tokenBOut,
    };
  }

  return {
    direction,
    inputMint: aIsSol ? snapshot.tokenMintB : snapshot.tokenMintA,
    outputMint: aIsSol ? snapshot.tokenMintA : snapshot.tokenMintB,
    amount: aIsSol ? snapshot.removePreview.tokenBOut : snapshot.removePreview.tokenAOut,
  };
}

function verifyReceipt(receipt: ReceiptAccount, expected: {
  authority: PublicKey;
  positionMint: PublicKey;
  epoch: number;
  direction: 0 | 1;
  attestationHashHex: string;
}): void {
  if (!receipt.authority.equals(expected.authority)) throw new Error('Receipt authority mismatch');
  if (!receipt.positionMint.equals(expected.positionMint)) throw new Error('Receipt position_mint mismatch');
  if (receipt.epoch !== expected.epoch) throw new Error('Receipt epoch mismatch');
  if (receipt.direction !== expected.direction) throw new Error('Receipt direction mismatch');
  const receiptHashHex = Buffer.from(receipt.attestationHash).toString('hex');
  if (receiptHashHex !== expected.attestationHashHex) throw new Error('Receipt stored_hash mismatch vs local attestation hash');
}

export async function runDevnetE2E(
  env: HarnessEnv = process.env,
  logger: HarnessLogger = (entry) => console.log(JSON.stringify(entry)),
  deps: HarnessDeps = defaultDeps,
): Promise<void> {
  const rpcUrl = parseRequiredEnv(env, 'RPC_URL');
  const authorityPath = parseRequiredEnv(env, 'AUTHORITY_KEYPAIR');
  const positionAddress = parseRequiredEnv(env, 'POSITION_ADDRESS');

  const authority = await loadAuthorityFromPath(authorityPath);
  const position = new PublicKey(positionAddress);
  const connection = new Connection(rpcUrl, 'confirmed');

  const config: AutopilotConfig = { ...DEFAULT_CONFIG, cluster: 'devnet' };

  log(logger, 'snapshot.fetch.start', { position: position.toBase58() });
  const snapshot = await deps.loadPositionSnapshot(connection, position, 'devnet');
  assertSolUsdcPair(snapshot.tokenMintA.toBase58(), snapshot.tokenMintB.toBase58(), 'devnet');
  log(logger, 'snapshot.fetch.ok', {
    currentTick: snapshot.currentTickIndex,
    lowerTick: snapshot.lowerTickIndex,
    upperTick: snapshot.upperTickIndex,
    pair: snapshot.pairLabel,
  });

  const nowMs = deps.nowMs();
  const unixTs = Math.floor(nowMs / 1000);
  const latestSlot = await deps.getSlot(connection);
  const samples = buildSamples(snapshot.currentTickIndex, unixTs, latestSlot);

  const policy = evaluateRangeBreak(
    samples,
    { lowerTickIndex: snapshot.lowerTickIndex, upperTickIndex: snapshot.upperTickIndex },
    config.policy,
    {},
  );

  log(logger, 'policy.evaluate.ok', { decision: policy.action, reasonCode: policy.reasonCode });

  if (policy.action === 'HOLD') {
    log(logger, 'harness.complete', { status: 'HOLD' });
    return;
  }

  const quotePlan = getQuoteMintsAndAmount(snapshot, policy.action);
  log(logger, 'quote.fetch.start', { direction: quotePlan.direction, amount: quotePlan.amount.toString() });
  const quote = await deps.fetchJupiterQuote({
    inputMint: quotePlan.inputMint,
    outputMint: quotePlan.outputMint,
    amount: quotePlan.amount,
    slippageBps: config.execution.slippageBpsCap,
  });

  const epoch = unixDaysFromUnixTs(unixTs);
  const [receiptPda] = deriveReceiptPda({
    authority: authority.publicKey,
    positionMint: snapshot.positionMint,
    epoch,
  });

  const existing = await deps.fetchReceiptByPda(connection, receiptPda);
  if (existing) {
    const err = new Error('Execution receipt already exists for this epoch');
    (err as Error & { code?: string }).code = 'ALREADY_EXECUTED_THIS_EPOCH';
    throw err;
  }
  log(logger, 'idempotency.check.ok', { receiptPda: receiptPda.toBase58(), epoch });

  const swapDecision = decideSwap(quote.inAmount, quotePlan.direction, config);
  const attestationPayload = encodeAttestationPayload({
    cluster: 'devnet',
    authority: authority.publicKey.toBase58(),
    position: snapshot.position.toBase58(),
    positionMint: snapshot.positionMint.toBase58(),
    whirlpool: snapshot.whirlpool.toBase58(),
    epoch,
    direction: decideDirection(policy.action),
    tickCurrent: snapshot.currentTickIndex,
    lowerTickIndex: snapshot.lowerTickIndex,
    upperTickIndex: snapshot.upperTickIndex,
    slippageBpsCap: config.execution.slippageBpsCap,
    quoteInputMint: quote.inputMint.toBase58(),
    quoteOutputMint: quote.outputMint.toBase58(),
    quoteInAmount: quote.inAmount,
    quoteMinOutAmount: quote.outAmount,
    quoteQuotedAtUnixMs: BigInt(quote.quotedAtUnixMs),
    swapPlanned: 1,
    swapExecuted: swapDecision.execute ? 1 : 0,
    swapReasonCode: swapDecision.reasonCode,
  });
  const attestationHash = computeAttestationHash({
    cluster: 'devnet',
    authority: authority.publicKey.toBase58(),
    position: snapshot.position.toBase58(),
    positionMint: snapshot.positionMint.toBase58(),
    whirlpool: snapshot.whirlpool.toBase58(),
    epoch,
    direction: decideDirection(policy.action),
    tickCurrent: snapshot.currentTickIndex,
    lowerTickIndex: snapshot.lowerTickIndex,
    upperTickIndex: snapshot.upperTickIndex,
    slippageBpsCap: config.execution.slippageBpsCap,
    quoteInputMint: quote.inputMint.toBase58(),
    quoteOutputMint: quote.outputMint.toBase58(),
    quoteInAmount: quote.inAmount,
    quoteMinOutAmount: quote.outAmount,
    quoteQuotedAtUnixMs: BigInt(quote.quotedAtUnixMs),
    swapPlanned: 1,
    swapExecuted: swapDecision.execute ? 1 : 0,
    swapReasonCode: swapDecision.reasonCode,
  });

  log(logger, 'tx.build-sim-send.start', { attestationHash: Buffer.from(attestationHash).toString('hex') });

  const result = await deps.executeOnce({
    connection,
    authority: authority.publicKey,
    position,
    samples,
    config,
    policyState: {},
    expectedMinOut: quote.outAmount.toString(),
    quoteAgeMs: Math.max(0, deps.nowMs() - quote.quotedAtUnixMs),
    quote,
    quoteContext: { quoteTickIndex: snapshot.currentTickIndex, quotedAtSlot: latestSlot },
    attestationHash,
    attestationPayloadBytes: attestationPayload,
    nowUnixMs: () => nowMs,
    signAndSend: async (tx: VersionedTransaction) => {
      tx.sign([authority]);
      return connection.sendRawTransaction(tx.serialize(), { maxRetries: 1 });
    },
    onSimulationComplete: () => log(logger, 'tx.simulate.ok', {}),
  });

  if (result.status !== 'EXECUTED' || !result.txSignature || !result.receiptPda) {
    const err = new Error(result.errorMessage ?? 'Execution failed');
    (err as Error & { code?: string }).code = result.errorCode;
    throw err;
  }

  log(logger, 'tx.send-confirm.ok', { signature: result.txSignature, receiptPda: result.receiptPda });

  const fetchedReceipt = await deps.fetchReceiptByPda(connection, new PublicKey(result.receiptPda));
  if (!fetchedReceipt) throw new Error('Receipt was not found after confirmed send');

  verifyReceipt(fetchedReceipt, {
    authority: authority.publicKey,
    positionMint: snapshot.positionMint,
    epoch,
    direction: decideDirection(policy.action),
    attestationHashHex: Buffer.from(attestationHash).toString('hex'),
  });

  log(logger, 'receipt.verify.ok', {
    authority: fetchedReceipt.authority.toBase58(),
    positionMint: fetchedReceipt.positionMint.toBase58(),
    epoch: fetchedReceipt.epoch,
    direction: fetchedReceipt.direction,
    storedHash: Buffer.from(fetchedReceipt.attestationHash).toString('hex'),
  });

  log(logger, 'harness.complete', { status: 'EXECUTED', signature: result.txSignature });
}
