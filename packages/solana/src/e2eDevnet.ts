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
  type SwapQuote,
} from '@clmm-autopilot/core';
import {
  type AccountInfo,
  Connection,
  Keypair,
  PublicKey,
  type RpcResponseAndContext,
  VersionedTransaction,
} from '@solana/web3.js';
import { executeOnce } from './executeOnce';
import { fetchJupiterQuote } from './jupiter';
import { loadPositionSnapshot, type PositionSnapshot } from './orcaInspector';
import { deriveReceiptPda, fetchReceiptByPda, type ReceiptAccount } from './receipt';
import { resolveReceiptRuntimeIdentity, type ReceiptRuntimeIdentity } from './receiptIdentity';
import { verifyReceiptProgramOnChain } from './receiptProgramVerification';
import { getSwapAdapter } from './swap/registry';
import { deriveSwapTickArrays } from './swap/tickArrays';

export type HarnessDecision = 'HOLD' | 'TRIGGER_DOWN' | 'TRIGGER_UP';

type HarnessEnv = Record<string, string | undefined>;
type HarnessError = Error & { code?: string };

const RECEIPT_MISMATCH_CODE = 'RECEIPT_MISMATCH';
const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const ZERO_PUBKEY = '11111111111111111111111111111111';

type HarnessLogger = (entry: Record<string, unknown>) => void;
type ResolvedHarnessPosition = {
  position: PublicKey;
  snapshot?: PositionSnapshot;
};

type HarnessDeps = {
  loadPositionSnapshot: typeof loadPositionSnapshot;
  fetchJupiterQuote: typeof fetchJupiterQuote;
  executeOnce: typeof executeOnce;
  fetchReceiptByPda: typeof fetchReceiptByPda;
  getSlot: (connection: Connection) => Promise<number>;
  getAccountInfo: (connection: Connection, pubkey: PublicKey) => Promise<AccountInfo<Buffer> | null>;
  getParsedAccountInfo: (connection: Connection, pubkey: PublicKey) => Promise<RpcResponseAndContext<any>>;
  nowMs: () => number;
};

const defaultDeps: HarnessDeps = {
  loadPositionSnapshot,
  fetchJupiterQuote,
  executeOnce,
  fetchReceiptByPda,
  getSlot: (connection) => connection.getSlot('confirmed'),
  getAccountInfo: (connection, pubkey) => connection.getAccountInfo(pubkey, 'confirmed'),
  getParsedAccountInfo: (connection, pubkey) => connection.getParsedAccountInfo(pubkey, 'confirmed'),
  nowMs: () => Date.now(),
};

function log(logger: HarnessLogger, step: string, fields: Record<string, unknown> = {}): void {
  logger({ ts: new Date().toISOString(), step, ...fields });
}

function codedError(code: string, message: string): HarnessError {
  const err = new Error(message) as HarnessError;
  err.code = code;
  return err;
}

function parseRequiredEnv(env: HarnessEnv, key: 'RPC_URL' | 'AUTHORITY_KEYPAIR'): string {
  const value = env[key]?.trim();
  if (!value) throw codedError('CONFIG_INVALID', `Missing required env: ${key}`);
  return value;
}

function parseOptionalEnv(env: HarnessEnv, key: 'POSITION_ADDRESS' | 'POSITION_ADDRESS_CANDIDATES'): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function parsePublicKeyValue(value: string, key: 'POSITION_ADDRESS' | 'POSITION_ADDRESS_CANDIDATES'): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw codedError('CONFIG_INVALID', `${key} must contain valid base58 public keys`);
  }
}

function parseCandidatePositions(env: HarnessEnv): PublicKey[] {
  const raw = parseOptionalEnv(env, 'POSITION_ADDRESS_CANDIDATES');
  if (!raw) return [];

  const seen = new Set<string>();
  const positions: PublicKey[] = [];
  for (const candidate of raw.split(/[,\s]+/)) {
    const trimmed = candidate.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    positions.push(parsePublicKeyValue(trimmed, 'POSITION_ADDRESS_CANDIDATES'));
  }
  return positions;
}

function assertPositionSourceConfigured(env: HarnessEnv): void {
  const explicitPosition = parseOptionalEnv(env, 'POSITION_ADDRESS');
  if (explicitPosition) {
    parsePublicKeyValue(explicitPosition, 'POSITION_ADDRESS');
    return;
  }
  if (parseCandidatePositions(env).length === 0) {
    throw codedError('CONFIG_INVALID', 'Missing required env: POSITION_ADDRESS or POSITION_ADDRESS_CANDIDATES');
  }
}

function parseSwapRouter(env: HarnessEnv): AutopilotConfig['execution']['swapRouter'] {
  const raw = env.SWAP_ROUTER?.trim();
  if (!raw) return 'noop';
  if (raw === 'noop' || raw === 'orca' || raw === 'jupiter') return raw;
  throw codedError('CONFIG_INVALID', `SWAP_ROUTER must be one of: noop, orca, jupiter (received '${raw}')`);
}

function parseForceDecision(env: HarnessEnv): Exclude<HarnessDecision, 'HOLD'> | undefined {
  const raw = env.FORCE_DECISION?.trim();
  if (!raw) return undefined;
  if (raw === 'TRIGGER_DOWN' || raw === 'TRIGGER_UP') return raw;
  throw codedError('CONFIG_INVALID', `FORCE_DECISION must be one of: TRIGGER_DOWN, TRIGGER_UP (received '${raw}')`);
}

function parseBooleanEnvFlag(env: HarnessEnv, key: string): boolean {
  const raw = env[key]?.trim();
  if (!raw) return false;
  if (raw === '1' || raw.toLowerCase() === 'true') return true;
  if (raw === '0' || raw.toLowerCase() === 'false') return false;
  throw codedError('CONFIG_INVALID', `${key} must be one of: 1, 0, true, false (received '${raw}')`);
}

function parseAuthority(secretKeyJson: string): Keypair {
  let raw: unknown;
  try {
    raw = JSON.parse(secretKeyJson);
  } catch {
    throw codedError('INVALID_KEYPAIR', 'AUTHORITY_KEYPAIR must point to a JSON keypair file (u8 array)');
  }
  if (!Array.isArray(raw)) throw codedError('INVALID_KEYPAIR', 'AUTHORITY_KEYPAIR file must contain a JSON array');
  if (raw.length !== 64) throw codedError('INVALID_KEYPAIR', 'AUTHORITY_KEYPAIR must be a 64-byte secretKey array');

  for (let i = 0; i < raw.length; i += 1) {
    const n = raw[i];
    if (!Number.isInteger(n) || n < 0 || n > 255) {
      throw codedError('INVALID_KEYPAIR', `AUTHORITY_KEYPAIR contains invalid byte at index ${i}`);
    }
  }

  const bytes = Uint8Array.from(raw as number[]);
  try {
    return Keypair.fromSecretKey(bytes);
  } catch {
    throw codedError('INVALID_KEYPAIR', 'AUTHORITY_KEYPAIR contains invalid key material');
  }
}

async function loadAuthorityFromPath(path: string): Promise<Keypair> {
  const fs = await import('node:fs/promises');
  return parseAuthority(await fs.readFile(path, 'utf8'));
}

function buildSamples(currentTickIndex: number, unixTs: number, latestSlot: number): Sample[] {
  const s0 = Math.max(0, latestSlot - 2);
  const s1 = Math.max(0, latestSlot - 1);
  const s2 = Math.max(0, latestSlot);
  return [
    { slot: s0, unixTs: unixTs - 4, currentTickIndex },
    { slot: s1, unixTs: unixTs - 2, currentTickIndex },
    { slot: s2, unixTs, currentTickIndex },
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
  aToB: boolean;
} {
  if (!snapshot.removePreview) {
    throw codedError('DATA_UNAVAILABLE', 'Remove preview unavailable for quote sizing');
  }

  const aIsSol = snapshot.tokenMintA.equals(SOL_MINT);
  const direction = decision === 'TRIGGER_UP' ? 'UP' : 'DOWN';

  if (direction === 'DOWN') {
    return {
      direction,
      inputMint: aIsSol ? snapshot.tokenMintA : snapshot.tokenMintB,
      outputMint: aIsSol ? snapshot.tokenMintB : snapshot.tokenMintA,
      amount: aIsSol ? snapshot.removePreview.tokenAOut : snapshot.removePreview.tokenBOut,
      aToB: aIsSol,
    };
  }

  return {
    direction,
    inputMint: aIsSol ? snapshot.tokenMintB : snapshot.tokenMintA,
    outputMint: aIsSol ? snapshot.tokenMintA : snapshot.tokenMintB,
    amount: aIsSol ? snapshot.removePreview.tokenBOut : snapshot.removePreview.tokenAOut,
    aToB: !aIsSol,
  };
}

function toSuppliedQuote(router: AutopilotConfig['execution']['swapRouter'], quote: SwapQuote): {
  inputMint: PublicKey;
  outputMint: PublicKey;
  inAmount: bigint;
  outAmount: bigint;
  quotedAtUnixMs: number;
  raw?: unknown;
} {
  const raw =
    router === 'jupiter'
      ? quote.debug?.jupiterRaw
      : router === 'orca'
        ? quote.debug?.orcaQuote
        : undefined;
  return {
    inputMint: new PublicKey(quote.inMint),
    outputMint: new PublicKey(quote.outMint),
    inAmount: quote.swapInAmount,
    outAmount: quote.swapMinOutAmount,
    quotedAtUnixMs: quote.quotedAtUnixSec * 1000,
    ...(raw !== undefined ? { raw } : {}),
  };
}

function verifyReceipt(receipt: ReceiptAccount, expected: {
  authority: PublicKey;
  positionMint: PublicKey;
  epoch: number;
  direction: 0 | 1;
  attestationHashHex: string;
}): void {
  if (!receipt.authority.equals(expected.authority)) throw codedError(RECEIPT_MISMATCH_CODE, 'Receipt authority mismatch');
  if (!receipt.positionMint.equals(expected.positionMint)) throw codedError(RECEIPT_MISMATCH_CODE, 'Receipt position_mint mismatch');
  if (receipt.epoch !== expected.epoch) throw codedError(RECEIPT_MISMATCH_CODE, 'Receipt epoch mismatch');
  if (receipt.direction !== expected.direction) throw codedError(RECEIPT_MISMATCH_CODE, 'Receipt direction mismatch');
  const receiptHashHex = Buffer.from(receipt.attestationHash).toString('hex');
  if (receiptHashHex !== expected.attestationHashHex) throw codedError(RECEIPT_MISMATCH_CODE, 'Receipt stored_hash mismatch vs local attestation hash');
}

async function resolveHarnessPosition(params: {
  env: HarnessEnv;
  authority: PublicKey;
  connection: Connection;
  epoch: number;
  receiptIdentity: ReceiptRuntimeIdentity;
  deps: HarnessDeps;
  logger: HarnessLogger;
}): Promise<ResolvedHarnessPosition> {
  const explicitPosition = parseOptionalEnv(params.env, 'POSITION_ADDRESS');
  if (explicitPosition) {
    return {
      position: parsePublicKeyValue(explicitPosition, 'POSITION_ADDRESS'),
    };
  }

  const candidates = parseCandidatePositions(params.env);
  if (candidates.length === 0) {
    throw codedError('CONFIG_INVALID', 'Missing required env: POSITION_ADDRESS or POSITION_ADDRESS_CANDIDATES');
  }

  let skippedAlreadyExecuted = 0;
  let skippedWrongPair = 0;
  const skippedErrors: Array<{ position: string; code: string; message: string }> = [];

  for (const candidate of candidates) {
    try {
      const snapshot = await params.deps.loadPositionSnapshot(params.connection, candidate, 'devnet');
      try {
        assertSolUsdcPair(snapshot.tokenMintA.toBase58(), snapshot.tokenMintB.toBase58(), 'devnet');
      } catch {
        skippedWrongPair += 1;
        log(params.logger, 'position.candidate.skip', {
          position: candidate.toBase58(),
          reason: 'NOT_SOL_USDC',
        });
        continue;
      }

      const [receiptPda] = deriveReceiptPda({
        authority: params.authority,
        positionMint: snapshot.positionMint,
        epoch: params.epoch,
        programId: params.receiptIdentity.programId,
      });
      const existing = await params.deps.fetchReceiptByPda(params.connection, receiptPda);
      if (existing) {
        skippedAlreadyExecuted += 1;
        log(params.logger, 'position.candidate.skip', {
          position: candidate.toBase58(),
          reason: 'ALREADY_EXECUTED_THIS_EPOCH',
          receiptPda: receiptPda.toBase58(),
        });
        continue;
      }

      log(params.logger, 'position.candidate.select', {
        position: candidate.toBase58(),
        receiptPda: receiptPda.toBase58(),
        epoch: params.epoch,
      });
      return {
        position: candidate,
        snapshot,
      };
    } catch (error) {
      const candidateError = error as HarnessError;
      skippedErrors.push({
        position: candidate.toBase58(),
        code: candidateError.code ?? 'UNKNOWN',
        message: candidateError.message,
      });
      log(params.logger, 'position.candidate.skip', {
        position: candidate.toBase58(),
        reason: candidateError.code ?? 'UNKNOWN',
      });
    }
  }

  if (skippedAlreadyExecuted > 0 && skippedWrongPair + skippedAlreadyExecuted === candidates.length && skippedErrors.length === 0) {
    throw codedError('ALREADY_EXECUTED_THIS_EPOCH', 'All candidate positions already have receipts for this epoch');
  }
  if (skippedWrongPair === candidates.length && skippedErrors.length === 0) {
    throw codedError('NOT_SOL_USDC', 'No candidate positions resolved to SOL/USDC');
  }
  if (skippedErrors.length > 0 && skippedAlreadyExecuted === 0 && skippedWrongPair === 0) {
    throw codedError(skippedErrors[0].code, skippedErrors[0].message);
  }

  const summary = [
    `checked=${candidates.length}`,
    `alreadyExecuted=${skippedAlreadyExecuted}`,
    `wrongPair=${skippedWrongPair}`,
    `errors=${skippedErrors.length}`,
  ].join(', ');
  throw codedError('CONFIG_INVALID', `No candidate positions available for receipt proof (${summary})`);
}

export async function runDevnetE2E(
  env: HarnessEnv = process.env,
  logger: HarnessLogger = (entry) => console.log(JSON.stringify(entry)),
  deps: HarnessDeps = defaultDeps,
): Promise<void> {
  const rpcUrl = parseRequiredEnv(env, 'RPC_URL');
  const authorityPath = parseRequiredEnv(env, 'AUTHORITY_KEYPAIR');
  const forceDecision = parseForceDecision(env);
  const requireReceiptProof = parseBooleanEnvFlag(env, 'REQUIRE_RECEIPT_PROOF');

  const authority = await loadAuthorityFromPath(authorityPath);
  assertPositionSourceConfigured(env);
  const connection = new Connection(rpcUrl, 'confirmed');

  const config: AutopilotConfig = {
    ...DEFAULT_CONFIG,
    cluster: 'devnet',
    execution: {
      ...DEFAULT_CONFIG.execution,
      swapRouter: parseSwapRouter(env),
    },
  };
  const receiptIdentity = resolveReceiptRuntimeIdentity(config, env);
  if (!receiptIdentity) {
    throw codedError('RECEIPT_PROGRAM_NOT_CONFIGURED', 'Resolved receipt identity is missing for devnet harness');
  }
  const verification = await verifyReceiptProgramOnChain(
    {
      getAccountInfo: (pubkey, commitment) => deps.getAccountInfo(connection, pubkey),
      getParsedAccountInfo: (pubkey, commitment) => deps.getParsedAccountInfo(connection, pubkey),
    },
    receiptIdentity,
  );
  log(logger, 'receipt.program.verify.ok', {
    programId: verification.programId,
    owner: verification.owner,
  });
  if (verification.programDataAddress) {
    log(logger, 'receipt.program.authority.ok', {
      programData: verification.programDataAddress,
      expectedUpgradeAuthority: receiptIdentity.expectedUpgradeAuthority?.toBase58(),
    });
  }
  const configuredAdapter = getSwapAdapter(config.execution.swapRouter, config.cluster);

  const runStartedMs = deps.nowMs();
  const unixTs = Math.floor(runStartedMs / 1000);
  const epoch = unixDaysFromUnixTs(unixTs);
  const resolvedPosition = await resolveHarnessPosition({
    env,
    authority: authority.publicKey,
    connection,
    epoch,
    receiptIdentity,
    deps,
    logger,
  });
  const position = resolvedPosition.position;

  log(logger, 'snapshot.fetch.start', { position: position.toBase58() });
  const snapshot = resolvedPosition.snapshot ?? await deps.loadPositionSnapshot(connection, position, 'devnet');
  assertSolUsdcPair(snapshot.tokenMintA.toBase58(), snapshot.tokenMintB.toBase58(), 'devnet');
  log(logger, 'snapshot.fetch.ok', {
    currentTick: snapshot.currentTickIndex,
    lowerTick: snapshot.lowerTickIndex,
    upperTick: snapshot.upperTickIndex,
    pair: snapshot.pairLabel,
  });

  const latestSlot = await deps.getSlot(connection);
  const samples = buildSamples(snapshot.currentTickIndex, unixTs, latestSlot);

  const policyEvaluated = evaluateRangeBreak(
    samples,
    { lowerTickIndex: snapshot.lowerTickIndex, upperTickIndex: snapshot.upperTickIndex },
    config.policy,
    {},
  );
  const decision = forceDecision ?? policyEvaluated.action;
  const reasonCode = forceDecision ? `FORCED_${forceDecision}` : policyEvaluated.reasonCode;

  log(logger, 'policy.evaluate.ok', { decision, reasonCode });

  if (decision === 'HOLD') {
    if (requireReceiptProof) {
      throw codedError(
        'RECEIPT_PROGRAM_VERIFICATION_FAILED',
        'Policy decision was HOLD while REQUIRE_RECEIPT_PROOF is enabled; set FORCE_DECISION or use a trigger-eligible position',
      );
    }
    log(logger, 'harness.complete', { status: 'HOLD' });
    return;
  }

  const [receiptPda] = deriveReceiptPda({
    authority: authority.publicKey,
    positionMint: snapshot.positionMint,
    epoch,
    programId: receiptIdentity.programId,
  });

  const existing = await deps.fetchReceiptByPda(connection, receiptPda);
  if (existing) {
    throw codedError('ALREADY_EXECUTED_THIS_EPOCH', 'Execution receipt already exists for this epoch');
  }
  log(logger, 'receipt.precheck.ok', { receiptPda: receiptPda.toBase58(), epoch, count: 0 });

  const quotePlan = getQuoteMintsAndAmount(snapshot, decision);
  const swapDecision = decideSwap(quotePlan.amount, quotePlan.direction, config);
  const swapPlanned = swapDecision.execute && config.execution.swapRouter !== 'noop';
  const swapSkipReason = !swapDecision.execute ? 'DUST' : config.execution.swapRouter === 'noop' ? 'ROUTER_DISABLED' : 'NONE';

  let suppliedQuote:
    | {
        inputMint: PublicKey;
        outputMint: PublicKey;
        inAmount: bigint;
        outAmount: bigint;
        quotedAtUnixMs: number;
        raw?: unknown;
      }
    | undefined;
  let planQuote: SwapQuote = {
    router: config.execution.swapRouter,
    inMint: ZERO_PUBKEY,
    outMint: ZERO_PUBKEY,
    swapInAmount: 0n,
    swapMinOutAmount: 0n,
    slippageBpsCap: config.execution.slippageBpsCap,
    quotedAtUnixSec: 0,
  };

  if (swapPlanned) {
    log(logger, 'quote.fetch.start', {
      router: config.execution.swapRouter,
      direction: quotePlan.direction,
      amount: quotePlan.amount.toString(),
    });
    const tickArrays = deriveSwapTickArrays({
      whirlpool: snapshot.whirlpool,
      tickSpacing: snapshot.tickSpacing,
      tickCurrentIndex: snapshot.currentTickIndex,
      aToB: quotePlan.aToB,
    });
    planQuote = await configuredAdapter.getQuote({
      cluster: config.cluster,
      inMint: quotePlan.inputMint.toBase58(),
      outMint: quotePlan.outputMint.toBase58(),
      swapInAmount: quotePlan.amount,
      slippageBpsCap: config.execution.slippageBpsCap,
      quoteFreshnessSec: config.execution.quoteFreshnessSec,
      swapContext: {
        connection,
        whirlpool: snapshot.whirlpool,
        tickSpacing: snapshot.tickSpacing,
        tickCurrentIndex: snapshot.currentTickIndex,
        tickArrays,
        tokenMintA: snapshot.tokenMintA,
        tokenMintB: snapshot.tokenMintB,
        tokenVaultA: snapshot.tokenVaultA,
        tokenVaultB: snapshot.tokenVaultB,
        tokenProgramA: snapshot.tokenProgramA,
        tokenProgramB: snapshot.tokenProgramB,
        aToB: quotePlan.aToB,
      },
    });
    suppliedQuote = toSuppliedQuote(config.execution.swapRouter, planQuote);
  } else {
    log(logger, 'quote.skip', { reason: swapSkipReason, router: config.execution.swapRouter });
  }

  const expectedMinOut = swapPlanned ? planQuote.swapMinOutAmount.toString() : '0';
  const quoteAgeMs = swapPlanned && suppliedQuote ? Math.max(0, deps.nowMs() - suppliedQuote.quotedAtUnixMs) : 0;
  const attestationPayload = encodeAttestationPayload({
    cluster: 'devnet',
    authority: authority.publicKey.toBase58(),
    position: snapshot.position.toBase58(),
    positionMint: snapshot.positionMint.toBase58(),
    whirlpool: snapshot.whirlpool.toBase58(),
    epoch,
    direction: decideDirection(decision),
    tickCurrent: snapshot.currentTickIndex,
    lowerTickIndex: snapshot.lowerTickIndex,
    upperTickIndex: snapshot.upperTickIndex,
    slippageBpsCap: config.execution.slippageBpsCap,
    quoteInputMint: swapPlanned ? planQuote.inMint : ZERO_PUBKEY,
    quoteOutputMint: swapPlanned ? planQuote.outMint : ZERO_PUBKEY,
    quoteInAmount: swapPlanned ? planQuote.swapInAmount : 0n,
    quoteMinOutAmount: swapPlanned ? planQuote.swapMinOutAmount : 0n,
    quoteQuotedAtUnixSec: swapPlanned ? planQuote.quotedAtUnixSec : 0,
    swapPlanned: swapPlanned ? 1 : 0,
    swapSkipReason,
    swapRouter: config.execution.swapRouter,
  });
  const attestationHash = computeAttestationHash({
    cluster: 'devnet',
    authority: authority.publicKey.toBase58(),
    position: snapshot.position.toBase58(),
    positionMint: snapshot.positionMint.toBase58(),
    whirlpool: snapshot.whirlpool.toBase58(),
    epoch,
    direction: decideDirection(decision),
    tickCurrent: snapshot.currentTickIndex,
    lowerTickIndex: snapshot.lowerTickIndex,
    upperTickIndex: snapshot.upperTickIndex,
    slippageBpsCap: config.execution.slippageBpsCap,
    quoteInputMint: swapPlanned ? planQuote.inMint : ZERO_PUBKEY,
    quoteOutputMint: swapPlanned ? planQuote.outMint : ZERO_PUBKEY,
    quoteInAmount: swapPlanned ? planQuote.swapInAmount : 0n,
    quoteMinOutAmount: swapPlanned ? planQuote.swapMinOutAmount : 0n,
    quoteQuotedAtUnixSec: swapPlanned ? planQuote.quotedAtUnixSec : 0,
    swapPlanned: swapPlanned ? 1 : 0,
    swapSkipReason,
    swapRouter: config.execution.swapRouter,
  });

  log(logger, 'tx.build-sim-send.start', { attestationHash: Buffer.from(attestationHash).toString('hex') });

  const executeParams = {
    connection,
    authority: authority.publicKey,
    receiptIdentityEnv: env,
    position,
    samples,
    config,
    policyState: {},
    expectedMinOut,
    quoteAgeMs,
    ...(forceDecision ? { decisionOverride: { decision: forceDecision, reasonCode } } : {}),
    ...(suppliedQuote ? { quote: suppliedQuote, quoteContext: { quoteTickIndex: snapshot.currentTickIndex, quotedAtSlot: latestSlot } } : {}),
    attestationHash,
    attestationPayloadBytes: attestationPayload,
    receiptEpochUnixMs: runStartedMs,
    nowUnixMs: () => deps.nowMs(),
    signAndSend: async (tx: VersionedTransaction) => {
      tx.sign([authority]);
      return connection.sendRawTransaction(tx.serialize(), { maxRetries: 1 });
    },
    onSimulationComplete: () => log(logger, 'tx.simulate.ok', {}),
  } as const;

  const result = await deps.executeOnce(executeParams);

  if (result.status !== 'EXECUTED' || !result.txSignature || !result.receiptPda) {
    throw codedError(result.errorCode ?? 'EXECUTION_FAILED', result.errorMessage ?? 'Execution failed');
  }
  if (result.receiptPda !== receiptPda.toBase58()) {
    throw codedError(RECEIPT_MISMATCH_CODE, 'Execution returned unexpected receipt PDA');
  }

  log(logger, 'tx.send-confirm.ok', { signature: result.txSignature, receiptPda: result.receiptPda });

  const fetchedReceipt = await deps.fetchReceiptByPda(connection, receiptPda);
  if (!fetchedReceipt) throw codedError('DATA_UNAVAILABLE', 'Receipt was not found after confirmed send');

  verifyReceipt(fetchedReceipt, {
    authority: authority.publicKey,
    positionMint: snapshot.positionMint,
    epoch,
    direction: decideDirection(decision),
    attestationHashHex: Buffer.from(attestationHash).toString('hex'),
  });

  log(logger, 'receipt.postcheck.ok', {
    receiptPda: receiptPda.toBase58(),
    count: 1,
  });
  log(logger, 'receipt.verify.ok', {
    authority: fetchedReceipt.authority.toBase58(),
    positionMint: fetchedReceipt.positionMint.toBase58(),
    epoch: fetchedReceipt.epoch,
    direction: fetchedReceipt.direction,
    storedHash: Buffer.from(fetchedReceipt.attestationHash).toString('hex'),
  });

  const duplicateResult = await deps.executeOnce(executeParams);
  if (duplicateResult.status !== 'ERROR' || duplicateResult.errorCode !== 'ALREADY_EXECUTED_THIS_EPOCH') {
    throw codedError(
      'RECEIPT_PROGRAM_VERIFICATION_FAILED',
      `Duplicate attempt in same epoch was not blocked deterministically (status=${duplicateResult.status}, code=${duplicateResult.errorCode ?? 'unknown'})`,
    );
  }
  log(logger, 'receipt.duplicate-block.ok', { code: duplicateResult.errorCode });

  log(logger, 'harness.complete', { status: 'EXECUTED', signature: result.txSignature });
}
