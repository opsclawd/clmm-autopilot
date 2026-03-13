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
  type VersionedTransactionResponse,
  VersionedTransaction,
} from '@solana/web3.js';
import { getAta } from './ata';
import { executeOnce, type ExecuteOnceCertificationHooks } from './executeOnce';
import { fetchJupiterQuote } from './jupiter';
import { loadPositionSnapshot, type PositionSnapshot } from './orcaInspector';
import { deriveReceiptPda, fetchReceiptByPda, type ReceiptAccount } from './receipt';
import { resolveReceiptRuntimeIdentity, type ReceiptRuntimeIdentity } from './receiptIdentity';
import { verifyReceiptProgramOnChain } from './receiptProgramVerification';
import { getSwapAdapter } from './swap/registry';
import { deriveSwapTickArrays } from './swap/tickArrays';
import { TOKEN_2022_PROGRAM_ID } from './token/constants';
import { CERTIFICATION_SCENARIOS } from './e2e/scenarios';
import {
  buildRunId,
  sanitizeRpcUrl,
  type CertificationStatus,
  type ResultArtifactV1,
  writeResultArtifact,
} from './e2e/resultArtifact';
import { allAssertionsPass, getAssertion, makeAssertion } from './e2e/assertions';

export type HarnessDecision = 'HOLD' | 'TRIGGER_DOWN' | 'TRIGGER_UP';

type HarnessEnv = Record<string, string | undefined>;
type HarnessError = Error & { code?: string };

const RECEIPT_MISMATCH_CODE = 'RECEIPT_MISMATCH';
const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const ZERO_PUBKEY = '11111111111111111111111111111111';

type HarnessLogger = (entry: Record<string, unknown>) => void;
export type CertificationScenarioName =
  | 'happy-path-trigger'
  | 'hold-path'
  | 'stale-quote-rebuild'
  | 'signing-delay-blockhash-drift'
  | 'rpc-retry-exhaustion'
  | 'unsupported-router-cluster'
  | 'receipt-misconfiguration'
  | 'token2022-certification'
  | 'duplicate-execution-same-epoch';

type OwnerStateSnapshot = {
  tokenA: bigint;
  tokenB: bigint;
  solLamports: bigint;
  feeOwedA: bigint | null;
  feeOwedB: bigint | null;
  liquidity: bigint;
};

type ScenarioExpectation = {
  expectedStatus?: CertificationStatus;
  expectedErrorCodes?: string[];
  allowSkip?: boolean;
  requireQuoteRebuilt?: boolean;
  requireBlockhashRefreshed?: boolean;
  requireRetryExhaustionKey?: string;
};

export type RunDevnetE2EOptions = {
  scenarioName?: CertificationScenarioName;
  artifactBaseDir?: string;
  expectation?: ScenarioExpectation;
  decisionOverride?: HarnessDecision;
  executeOnceHooks?: ExecuteOnceCertificationHooks;
};

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
  getBalance: (connection: Connection, pubkey: PublicKey) => Promise<number>;
  getAccountInfo: (connection: Connection, pubkey: PublicKey) => Promise<AccountInfo<Buffer> | null>;
  getParsedAccountInfo: (connection: Connection, pubkey: PublicKey) => Promise<RpcResponseAndContext<any>>;
  getTransaction: (connection: Connection, signature: string) => Promise<VersionedTransactionResponse | null>;
  nowMs: () => number;
};

const defaultDeps: HarnessDeps = {
  loadPositionSnapshot,
  fetchJupiterQuote,
  executeOnce,
  fetchReceiptByPda,
  getSlot: (connection) => connection.getSlot('confirmed'),
  getBalance: (connection, pubkey) => connection.getBalance(pubkey, 'confirmed'),
  getAccountInfo: (connection, pubkey) => connection.getAccountInfo(pubkey, 'confirmed'),
  getParsedAccountInfo: (connection, pubkey) => connection.getParsedAccountInfo(pubkey, 'confirmed'),
  getTransaction: (connection, signature) =>
    connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    }),
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

function parseOptionalToken2022Position(env: HarnessEnv): string | undefined {
  const value = env.TOKEN2022_POSITION_ADDRESS?.trim();
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

async function runOptionalToken2022Scenario(params: {
  env: HarnessEnv;
  connection: Connection;
  deps: HarnessDeps;
  logger: HarnessLogger;
}): Promise<void> {
  const rawPosition = parseOptionalToken2022Position(params.env);
  if (!rawPosition) {
    log(params.logger, 'token2022.optional.skip', { reason: 'NOT_CONFIGURED' });
    return;
  }

  let position: PublicKey;
  try {
    position = new PublicKey(rawPosition);
  } catch {
    log(params.logger, 'token2022.optional.skip', { reason: 'INVALID_POSITION_ADDRESS' });
    return;
  }

  try {
    const snapshot = await params.deps.loadPositionSnapshot(params.connection, position, 'devnet');
    const hasToken2022 =
      snapshot.tokenProgramA.equals(TOKEN_2022_PROGRAM_ID) || snapshot.tokenProgramB.equals(TOKEN_2022_PROGRAM_ID);
    if (!hasToken2022) {
      log(params.logger, 'token2022.optional.skip', {
        reason: 'NO_TOKEN2022_MINT',
        position: position.toBase58(),
        tokenProgramA: snapshot.tokenProgramA.toBase58(),
        tokenProgramB: snapshot.tokenProgramB.toBase58(),
      });
      return;
    }

    log(params.logger, 'token2022.optional.ok', {
      position: position.toBase58(),
      tokenProgramA: snapshot.tokenProgramA.toBase58(),
      tokenProgramB: snapshot.tokenProgramB.toBase58(),
    });
  } catch (error) {
    const err = error as HarnessError;
    log(params.logger, 'token2022.optional.skip', {
      reason: err.code ?? 'LOAD_FAILED',
      message: err.message,
      position: position.toBase58(),
    });
  }
}

function parseArtifactDir(env: HarnessEnv, override?: string): string | undefined {
  const fromOverride = override?.trim();
  if (fromOverride) return fromOverride;
  const fromEnv = env.E2E_ARTIFACT_DIR?.trim();
  return fromEnv || undefined;
}

function bigintOrNull(value: bigint | undefined): bigint | null {
  return value === undefined ? null : value;
}

function parseParsedTokenAmount(parsedValue: unknown): bigint {
  if (!parsedValue || typeof parsedValue !== 'object') return BigInt(0);
  const data = parsedValue as { value?: { data?: { parsed?: { info?: { tokenAmount?: { amount?: string } } } } } };
  const amount = data.value?.data?.parsed?.info?.tokenAmount?.amount;
  if (typeof amount !== 'string') return BigInt(0);
  try {
    return BigInt(amount);
  } catch {
    return BigInt(0);
  }
}

async function readOwnerMintAmount(params: {
  deps: HarnessDeps;
  connection: Connection;
  owner: PublicKey;
  mint: PublicKey;
  tokenProgram: PublicKey;
}): Promise<bigint> {
  try {
    if (params.mint.equals(SOL_MINT)) {
      return BigInt(await params.deps.getBalance(params.connection, params.owner));
    }
    const ata = getAta(params.mint, params.owner, params.tokenProgram);
    const parsed = await params.deps.getParsedAccountInfo(params.connection, ata);
    return parseParsedTokenAmount(parsed);
  } catch {
    return BigInt(0);
  }
}

async function captureOwnerState(params: {
  deps: HarnessDeps;
  connection: Connection;
  authority: PublicKey;
  snapshot: PositionSnapshot;
}): Promise<OwnerStateSnapshot> {
  const [tokenA, tokenB, solLamports] = await Promise.all([
    readOwnerMintAmount({
      deps: params.deps,
      connection: params.connection,
      owner: params.authority,
      mint: params.snapshot.tokenMintA,
      tokenProgram: params.snapshot.tokenProgramA,
    }),
    readOwnerMintAmount({
      deps: params.deps,
      connection: params.connection,
      owner: params.authority,
      mint: params.snapshot.tokenMintB,
      tokenProgram: params.snapshot.tokenProgramB,
    }),
    params.deps.getBalance(params.connection, params.authority).then((value) => BigInt(value)),
  ]);
  return {
    tokenA,
    tokenB,
    solLamports,
    feeOwedA: bigintOrNull(params.snapshot.feeOwedA),
    feeOwedB: bigintOrNull(params.snapshot.feeOwedB),
    liquidity: params.snapshot.liquidity,
  };
}

function isValidSwapSkipReason(reason: string): boolean {
  return reason === 'DUST' || reason === 'ROUTER_DISABLED' || reason === 'NONE';
}

function computeDirectionalTargetDelta(params: {
  decision: Exclude<HarnessDecision, 'HOLD'>;
  snapshot: PositionSnapshot;
  pre: OwnerStateSnapshot;
  post: OwnerStateSnapshot;
  txFeeLamports: bigint;
}): bigint {
  const aIsSol = params.snapshot.tokenMintA.equals(SOL_MINT);
  const targetKey = params.decision === 'TRIGGER_DOWN' ? (aIsSol ? 'tokenB' : 'tokenA') : (aIsSol ? 'tokenA' : 'tokenB');
  const preTarget = params.pre[targetKey];
  const postTarget = params.post[targetKey];
  if (params.decision === 'TRIGGER_UP' && ((aIsSol && targetKey === 'tokenA') || (!aIsSol && targetKey === 'tokenB'))) {
    return (postTarget - preTarget) + params.txFeeLamports;
  }
  return postTarget - preTarget;
}

function summarizeError(error: unknown): { code: string; message: string } {
  const err = error as HarnessError;
  return {
    code: err?.code ?? 'UNKNOWN',
    message: err?.message ?? String(error),
  };
}

export async function runDevnetE2EWithArtifact(
  env: HarnessEnv = process.env,
  logger: HarnessLogger = (entry) => console.log(JSON.stringify(entry)),
  deps: HarnessDeps = defaultDeps,
  options: RunDevnetE2EOptions = {},
): Promise<ResultArtifactV1> {
  const scenarioName = options.scenarioName ?? 'happy-path-trigger';
  const runStartedMs = deps.nowMs();
  const runId = buildRunId({
    nowMs: runStartedMs,
    scenarioName,
    position: env.POSITION_ADDRESS,
  });
  const artifactBaseDir = parseArtifactDir(env, options.artifactBaseDir);
  const assertions: ReturnType<typeof makeAssertion>[] = [];
  const errors: Array<{ code: string; message: string }> = [];
  let status: CertificationStatus = 'FAIL';

  let rpcUrl = '';
  let authority = '';
  let position = '';
  let whirlpool = '';
  let decision: HarnessDecision = 'HOLD';
  let decisionReasonCode = 'NOT_EVALUATED';
  let swapRouter = 'noop';
  let swapPlanned = false;
  let swapSkipped = true;
  let swapSkipReason: 'NONE' | 'DUST' | 'ROUTER_DISABLED' = 'NONE';
  let txBuilt = false;
  let txSimulated = false;
  let txSent = false;
  let txSignature = '';
  let receiptPdaBase58 = '';
  let receiptFoundBefore = false;
  let receiptFoundAfter = false;
  let skipReason = '';

  try {
    const rpcUrlRaw = parseRequiredEnv(env, 'RPC_URL');
    rpcUrl = sanitizeRpcUrl(rpcUrlRaw);
    const authorityPath = parseRequiredEnv(env, 'AUTHORITY_KEYPAIR');
    const forceDecision = parseForceDecision(env);
    const requireReceiptProof = parseBooleanEnvFlag(env, 'REQUIRE_RECEIPT_PROOF');

    const authorityKp = await loadAuthorityFromPath(authorityPath);
    authority = authorityKp.publicKey.toBase58();
    assertPositionSourceConfigured(env);
    const connection = new Connection(rpcUrlRaw, 'confirmed');

    const config: AutopilotConfig = {
      ...DEFAULT_CONFIG,
      cluster: 'devnet',
      execution: {
        ...DEFAULT_CONFIG.execution,
        swapRouter: parseSwapRouter(env),
      },
    };
    swapRouter = config.execution.swapRouter;
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

    const unixTs = Math.floor(runStartedMs / 1000);
    const epoch = unixDaysFromUnixTs(unixTs);
    const resolvedPosition = await resolveHarnessPosition({
      env,
      authority: authorityKp.publicKey,
      connection,
      epoch,
      receiptIdentity,
      deps,
      logger,
    });
    const positionKey = resolvedPosition.position;
    position = positionKey.toBase58();

    log(logger, 'snapshot.fetch.start', { position });
    const snapshot = resolvedPosition.snapshot ?? await deps.loadPositionSnapshot(connection, positionKey, 'devnet');
    assertSolUsdcPair(snapshot.tokenMintA.toBase58(), snapshot.tokenMintB.toBase58(), 'devnet');
    whirlpool = snapshot.whirlpool.toBase58();
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
    decision = options.decisionOverride ?? forceDecision ?? policyEvaluated.action;
    decisionReasonCode = options.decisionOverride
      ? `SCENARIO_${options.decisionOverride}`
      : forceDecision
        ? `FORCED_${forceDecision}`
        : policyEvaluated.reasonCode;
    assertions.push(makeAssertion({
      name: 'decision.isExpected',
      pass: true,
      actual: decision,
      expected: decision,
      reasonCode: decisionReasonCode,
    }));

    log(logger, 'policy.evaluate.ok', { decision, reasonCode: decisionReasonCode });

    if (decision === 'HOLD') {
      await runOptionalToken2022Scenario({ env, connection, deps, logger });
      if (requireReceiptProof) {
        throw codedError(
          'RECEIPT_PROGRAM_VERIFICATION_FAILED',
          'Policy decision was HOLD while REQUIRE_RECEIPT_PROOF is enabled; set FORCE_DECISION or use a trigger-eligible position',
        );
      }
      assertions.push(makeAssertion({
        name: 'tx.notBuilt',
        pass: true,
        actual: false,
        expected: false,
      }));
      assertions.push(makeAssertion({
        name: 'receipt.notAttempted',
        pass: true,
        actual: false,
        expected: false,
      }));
      status = 'HOLD';
      log(logger, 'harness.complete', { status: 'HOLD' });
    } else {
      const preState = await captureOwnerState({
        deps,
        connection,
        authority: authorityKp.publicKey,
        snapshot,
      });

      const [receiptPda] = deriveReceiptPda({
        authority: authorityKp.publicKey,
        positionMint: snapshot.positionMint,
        epoch,
        programId: receiptIdentity.programId,
      });
      receiptPdaBase58 = receiptPda.toBase58();

      const existing = await deps.fetchReceiptByPda(connection, receiptPda);
      receiptFoundBefore = Boolean(existing);
      assertions.push(makeAssertion({
        name: 'precheck.receiptAbsent',
        pass: !receiptFoundBefore,
        actual: receiptFoundBefore ? 1 : 0,
        expected: 0,
      }));
      if (existing) {
        throw codedError('ALREADY_EXECUTED_THIS_EPOCH', 'Execution receipt already exists for this epoch');
      }
      log(logger, 'receipt.precheck.ok', { receiptPda: receiptPda.toBase58(), epoch, count: 0 });

      const quotePlan = getQuoteMintsAndAmount(snapshot, decision);
      const swapDecision = decideSwap(quotePlan.amount, quotePlan.direction, config);
      swapPlanned = swapDecision.execute && config.execution.swapRouter !== 'noop';
      swapSkipReason = !swapDecision.execute ? 'DUST' : config.execution.swapRouter === 'noop' ? 'ROUTER_DISABLED' : 'NONE';
      swapSkipped = !swapPlanned;

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
        swapInAmount: BigInt(0),
        swapMinOutAmount: BigInt(0),
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
        authority: authorityKp.publicKey.toBase58(),
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
        quoteInAmount: swapPlanned ? planQuote.swapInAmount : BigInt(0),
        quoteMinOutAmount: swapPlanned ? planQuote.swapMinOutAmount : BigInt(0),
        quoteQuotedAtUnixSec: swapPlanned ? planQuote.quotedAtUnixSec : 0,
        swapPlanned: swapPlanned ? 1 : 0,
        swapSkipReason,
        swapRouter: config.execution.swapRouter,
      });
      const attestationHash = computeAttestationHash({
        cluster: 'devnet',
        authority: authorityKp.publicKey.toBase58(),
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
        quoteInAmount: swapPlanned ? planQuote.swapInAmount : BigInt(0),
        quoteMinOutAmount: swapPlanned ? planQuote.swapMinOutAmount : BigInt(0),
        quoteQuotedAtUnixSec: swapPlanned ? planQuote.quotedAtUnixSec : 0,
        swapPlanned: swapPlanned ? 1 : 0,
        swapSkipReason,
        swapRouter: config.execution.swapRouter,
      });

      log(logger, 'tx.build-sim-send.start', { attestationHash: Buffer.from(attestationHash).toString('hex') });

      const executeParams = {
        connection,
        authority: authorityKp.publicKey,
        receiptIdentityEnv: env,
        position: positionKey,
        samples,
        config,
        policyState: {},
        expectedMinOut,
        quoteAgeMs,
        ...((options.decisionOverride && options.decisionOverride !== 'HOLD')
          ? { decisionOverride: { decision: options.decisionOverride, reasonCode: decisionReasonCode } }
          : forceDecision
            ? { decisionOverride: { decision: forceDecision, reasonCode: decisionReasonCode } }
            : {}),
        ...(suppliedQuote ? { quote: suppliedQuote, quoteContext: { quoteTickIndex: snapshot.currentTickIndex, quotedAtSlot: latestSlot } } : {}),
        attestationHash,
        attestationPayloadBytes: attestationPayload,
        receiptEpochUnixMs: runStartedMs,
        nowUnixMs: () => deps.nowMs(),
        signAndSend: async (tx: VersionedTransaction) => {
          tx.sign([authorityKp]);
          return connection.sendRawTransaction(tx.serialize(), { maxRetries: 1 });
        },
        onSimulationComplete: () => log(logger, 'tx.simulate.ok', {}),
        ...(options.executeOnceHooks ? { certificationHooks: options.executeOnceHooks } : {}),
      } as const;

      const result = await deps.executeOnce(executeParams);
      const reliability = result.metadata?.reliability;
      txBuilt = result.execution?.unsignedTxBuilt ?? result.status === 'EXECUTED';
      txSimulated = result.execution?.simulated ?? result.status === 'EXECUTED';
      txSent = Boolean(result.txSignature);
      txSignature = result.txSignature ?? '';
      assertions.push(makeAssertion({
        name: 'tx.buildSucceeded',
        pass: txBuilt,
        actual: txBuilt,
        expected: true,
      }));
      assertions.push(makeAssertion({
        name: 'tx.simulationSucceeded',
        pass: txSimulated,
        actual: txSimulated,
        expected: true,
      }));
      assertions.push(makeAssertion({
        name: 'tx.confirmed',
        pass: result.status === 'EXECUTED' && txSent,
        actual: result.status,
        expected: 'EXECUTED',
      }));
      if (options.expectation?.requireQuoteRebuilt !== undefined) {
        const quoteRebuilt = Boolean(reliability?.quoteRebuilt);
        assertions.push(makeAssertion({
          name: 'scenario.quoteRebuilt',
          pass: quoteRebuilt === options.expectation.requireQuoteRebuilt,
          actual: quoteRebuilt,
          expected: options.expectation.requireQuoteRebuilt,
        }));
      }
      if (options.expectation?.requireBlockhashRefreshed !== undefined) {
        const refreshed = Boolean(reliability?.blockhashRefreshed);
        assertions.push(makeAssertion({
          name: 'scenario.blockhashRefreshed',
          pass: refreshed === options.expectation.requireBlockhashRefreshed,
          actual: refreshed,
          expected: options.expectation.requireBlockhashRefreshed,
        }));
      }
      if (options.expectation?.requireRetryExhaustionKey) {
        const attempts = reliability?.retryAttempts?.[options.expectation.requireRetryExhaustionKey] ?? 0;
        assertions.push(makeAssertion({
          name: 'scenario.retryExhausted',
          pass: attempts === config.execution.maxRetries,
          actual: attempts,
          expected: config.execution.maxRetries,
          reasonCode: options.expectation.requireRetryExhaustionKey,
        }));
      }

      if (result.status !== 'EXECUTED' || !result.txSignature || !result.receiptPda) {
        throw codedError(result.errorCode ?? 'EXECUTION_FAILED', result.errorMessage ?? 'Execution failed');
      }
      if (result.receiptPda !== receiptPda.toBase58()) {
        throw codedError(RECEIPT_MISMATCH_CODE, 'Execution returned unexpected receipt PDA');
      }

      log(logger, 'tx.send-confirm.ok', { signature: result.txSignature, receiptPda: result.receiptPda });

      const fetchedReceipt = await deps.fetchReceiptByPda(connection, receiptPda);
      receiptFoundAfter = Boolean(fetchedReceipt);
      assertions.push(makeAssertion({
        name: 'post.receiptPresent',
        pass: receiptFoundAfter,
        actual: receiptFoundAfter ? 1 : 0,
        expected: 1,
      }));
      if (!fetchedReceipt) throw codedError('DATA_UNAVAILABLE', 'Receipt was not found after confirmed send');

      verifyReceipt(fetchedReceipt, {
        authority: authorityKp.publicKey,
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
      const duplicateBlocked = duplicateResult.status === 'ERROR' && duplicateResult.errorCode === 'ALREADY_EXECUTED_THIS_EPOCH';
      assertions.push(makeAssertion({
        name: 'post.duplicateBlocked',
        pass: duplicateBlocked,
        actual: duplicateResult.errorCode ?? duplicateResult.status,
        expected: 'ALREADY_EXECUTED_THIS_EPOCH',
      }));
      if (!duplicateBlocked) {
        throw codedError(
          'RECEIPT_PROGRAM_VERIFICATION_FAILED',
          `Duplicate attempt in same epoch was not blocked deterministically (status=${duplicateResult.status}, code=${duplicateResult.errorCode ?? 'unknown'})`,
        );
      }
      log(logger, 'receipt.duplicate-block.ok', { code: duplicateResult.errorCode });

      const postSnapshot = await deps.loadPositionSnapshot(connection, positionKey, 'devnet');
      const postState = await captureOwnerState({
        deps,
        connection,
        authority: authorityKp.publicKey,
        snapshot: postSnapshot,
      });

      assertions.push(makeAssertion({
        name: 'post.liquidityZero',
        pass: postSnapshot.liquidity === BigInt(0),
        actual: postSnapshot.liquidity.toString(),
        expected: '0',
      }));

      const txResp = txSignature ? await deps.getTransaction(connection, txSignature) : null;
      const txFeeLamports = BigInt(txResp?.meta?.fee ?? 0);
      const directionalDelta = computeDirectionalTargetDelta({
        decision,
        snapshot,
        pre: preState,
        post: postState,
        txFeeLamports,
      });
      const balanceDeltaValid = swapPlanned ? directionalDelta > BigInt(0) : directionalDelta >= BigInt(0);
      assertions.push(makeAssertion({
        name: 'post.balanceDeltaValid',
        pass: balanceDeltaValid,
        actual: directionalDelta.toString(),
        expected: swapPlanned ? '>0' : '>=0',
      }));

      const swapInstructionCount = result.metadata?.swap?.swapInstructionCount ?? 0;
      const swapOutcomeValid = swapPlanned
        ? balanceDeltaValid && swapInstructionCount > 0
        : isValidSwapSkipReason(swapSkipReason);
      assertions.push(makeAssertion({
        name: 'post.swapExecutedOrValidlySkipped',
        pass: swapOutcomeValid,
        actual: swapPlanned ? { balanceDeltaValid, swapInstructionCount } : { swapSkipReason },
        expected: swapPlanned ? { balanceDeltaValid: true, swapInstructionCount: '>0' } : { swapSkipReason: 'DUST|ROUTER_DISABLED' },
      }));

      const preAccruedKnown = preState.feeOwedA !== null && preState.feeOwedB !== null;
      const postAccruedKnown = postState.feeOwedA !== null && postState.feeOwedB !== null;
      const preAccrued = (preState.feeOwedA ?? BigInt(0)) + (preState.feeOwedB ?? BigInt(0));
      const postAccrued = (postState.feeOwedA ?? BigInt(0)) + (postState.feeOwedB ?? BigInt(0));
      const ownerIncreaseFallback = postState.tokenA > preState.tokenA || postState.tokenB > preState.tokenB;
      const collectEvidence = Boolean(result.metadata?.executionIntent.collectFeesPlanned) &&
        Boolean(txResp?.meta && txResp.meta.err === null);
      let feesPass = false;
      let feeReasonCode = 'FEE_PROOF_MISSING';
      if (preAccruedKnown && preAccrued === BigInt(0)) {
        feesPass = true;
        feeReasonCode = 'NO_FEES_ACCRUED';
      } else if (preAccruedKnown && postAccruedKnown) {
        const accrualReduced = postAccrued < preAccrued;
        feesPass = accrualReduced && collectEvidence;
        if (feesPass) feeReasonCode = 'ACCRUAL_REDUCED';
      } else {
        feesPass = ownerIncreaseFallback && collectEvidence;
        if (feesPass) feeReasonCode = 'OWNER_BALANCE_FALLBACK';
      }
      assertions.push(makeAssertion({
        name: 'post.feesCollected',
        pass: feesPass,
        actual: {
          preAccrued: preAccrued.toString(),
          postAccrued: postAccrued.toString(),
          ownerIncreaseFallback,
          collectEvidence,
        },
        expected: {
          feeProof: true,
        },
        reasonCode: feeReasonCode,
      }));

      await runOptionalToken2022Scenario({ env, connection, deps, logger });
      status = allAssertionsPass(assertions) ? 'PASS' : 'FAIL';
      log(logger, 'harness.complete', { status: 'EXECUTED', signature: result.txSignature });
    }
  } catch (error) {
    const normalized = summarizeError(error);
    errors.push(normalized);
    const expectedErrorCodes = options.expectation?.expectedErrorCodes ?? [];
    const matchesExpected = expectedErrorCodes.includes(normalized.code);
    assertions.push(makeAssertion({
      name: 'error.matchesExpected',
      pass: expectedErrorCodes.length === 0 ? false : matchesExpected,
      actual: normalized.code,
      expected: expectedErrorCodes.length === 0 ? 'none' : expectedErrorCodes.join('|'),
    }));
    status = matchesExpected ? 'EXPECTED_FAILURE' : 'FAIL';
  }

  if (options.expectation?.allowSkip && scenarioName === 'token2022-certification') {
    const rawToken2022Position = parseOptionalToken2022Position(env);
    if (!rawToken2022Position) {
      status = 'SKIPPED';
      skipReason = 'SCENARIO_SKIPPED_NOT_CONFIGURED';
      assertions.push(makeAssertion({
        name: 'error.matchesExpected',
        pass: true,
        actual: skipReason,
        expected: skipReason,
        reasonCode: skipReason,
      }));
    }
  }
  if (options.expectation?.expectedErrorCodes?.length && status !== 'EXPECTED_FAILURE' && status !== 'SKIPPED') {
    const expectedCodes = options.expectation.expectedErrorCodes.join('|');
    if (!getAssertion(assertions, 'error.matchesExpected')) {
      assertions.push(makeAssertion({
        name: 'error.matchesExpected',
        pass: false,
        actual: errors[0]?.code ?? 'NO_ERROR',
        expected: expectedCodes,
      }));
    }
    errors.push({
      code: 'CERT_EXPECTED_FAILURE_NOT_OBSERVED',
      message: `Scenario '${scenarioName}' expected one of [${expectedCodes}] but completed with status '${status}'`,
    });
    status = 'FAIL';
  }
  if (options.expectation?.expectedStatus) {
    const statusMatchesExpected = status === options.expectation.expectedStatus;
    assertions.push(makeAssertion({
      name: 'scenario.statusMatchesExpected',
      pass: statusMatchesExpected,
      actual: status,
      expected: options.expectation.expectedStatus,
    }));
    if (!statusMatchesExpected && status !== 'SKIPPED') {
      errors.push({
        code: 'CERT_SCENARIO_STATUS_MISMATCH',
        message: `Scenario '${scenarioName}' completed with status '${status}' (expected '${options.expectation.expectedStatus}')`,
      });
      status = 'FAIL';
    }
  }
  if (status === 'FAIL' && errors.length === 0) {
    errors.push({
      code: 'CERT_ASSERTION_FAILED',
      message: 'One or more certification assertions failed',
    });
  }

  const artifact: ResultArtifactV1 = {
    schemaVersion: 1,
    runId,
    timestamp: new Date(runStartedMs).toISOString(),
    cluster: 'devnet',
    rpcUrl,
    position,
    whirlpool,
    authority,
    decision,
    decisionReasonCode,
    swapRouter,
    swapPlanned,
    swapSkipped,
    swapSkipReason,
    txBuilt,
    txSimulated,
    txSent,
    txSignature,
    receiptPda: receiptPdaBase58,
    receiptFoundBefore,
    receiptFoundAfter,
    status,
    skipReason,
    assertions,
    errors,
    scenarioName,
  };
  const path = await writeResultArtifact({
    artifact,
    scenarioName,
    ...(artifactBaseDir ? { baseDir: artifactBaseDir } : {}),
  });
  log(logger, 'artifact.write.ok', { path, status, scenarioName });
  return artifact;
}

export async function runDevnetE2E(
  env: HarnessEnv = process.env,
  logger: HarnessLogger = (entry) => console.log(JSON.stringify(entry)),
  deps: HarnessDeps = defaultDeps,
): Promise<void> {
  const artifact = await runDevnetE2EWithArtifact(env, logger, deps);
  if (artifact.status === 'FAIL') {
    const first = artifact.errors[0];
    throw codedError(first?.code ?? 'UNKNOWN', first?.message ?? 'Harness failed');
  }
}

export async function runCertificationScenario(
  name: CertificationScenarioName,
  env: HarnessEnv = process.env,
  logger: HarnessLogger = (entry) => console.log(JSON.stringify(entry)),
  deps: HarnessDeps = defaultDeps,
): Promise<ResultArtifactV1> {
  const scenarioEnv: HarnessEnv = { ...env };
  const scenarioOptions: RunDevnetE2EOptions = { scenarioName: name };

  if (name === 'hold-path') {
    scenarioOptions.decisionOverride = 'HOLD';
    scenarioOptions.expectation = { expectedStatus: 'HOLD' };
  }
  if (name === 'happy-path-trigger' || name === 'duplicate-execution-same-epoch') {
    scenarioOptions.decisionOverride = 'TRIGGER_DOWN';
  }
  if (name === 'unsupported-router-cluster') {
    scenarioEnv.SWAP_ROUTER = 'jupiter';
    scenarioOptions.expectation = {
      expectedStatus: 'EXPECTED_FAILURE',
      expectedErrorCodes: ['SWAP_ROUTER_UNSUPPORTED_CLUSTER'],
    };
  }
  if (name === 'receipt-misconfiguration') {
    scenarioEnv.RECEIPT_IDENTITY_SOURCE = 'config';
    scenarioOptions.expectation = {
      expectedStatus: 'EXPECTED_FAILURE',
      expectedErrorCodes: ['RECEIPT_PROGRAM_NOT_CONFIGURED', 'RECEIPT_PROGRAM_VERIFICATION_FAILED'],
    };
  }
  if (name === 'rpc-retry-exhaustion') {
    scenarioOptions.decisionOverride = 'TRIGGER_DOWN';
    scenarioOptions.executeOnceHooks = {
      forceRetryError: {
        key: 'refreshPositionDecision',
        code: 'RPC_TRANSIENT',
        message: 'forced certification retry exhaustion',
        retryable: true,
      },
    };
    scenarioOptions.expectation = {
      expectedStatus: 'EXPECTED_FAILURE',
      expectedErrorCodes: ['RPC_TRANSIENT'],
      requireRetryExhaustionKey: 'refreshPositionDecision',
    };
  }
  if (name === 'token2022-certification') {
    scenarioOptions.expectation = { allowSkip: true };
  }
  if (name === 'stale-quote-rebuild') {
    scenarioOptions.decisionOverride = 'TRIGGER_DOWN';
    scenarioOptions.executeOnceHooks = { forceQuoteRebuildReason: 'QUOTE_STALE' };
    scenarioOptions.expectation = { expectedStatus: 'PASS', requireQuoteRebuilt: true };
  }
  if (name === 'signing-delay-blockhash-drift') {
    scenarioOptions.decisionOverride = 'TRIGGER_DOWN';
    scenarioOptions.executeOnceHooks = { forceBlockhashRefresh: true };
    scenarioOptions.expectation = { expectedStatus: 'PASS', requireBlockhashRefreshed: true };
  }

  return runDevnetE2EWithArtifact(scenarioEnv, logger, deps, scenarioOptions);
}

export async function runCertificationSuite(
  env: HarnessEnv = process.env,
  logger: HarnessLogger = (entry) => console.log(JSON.stringify(entry)),
  deps: HarnessDeps = defaultDeps,
): Promise<ResultArtifactV1[]> {
  const out: ResultArtifactV1[] = [];
  for (const scenario of CERTIFICATION_SCENARIOS) {
    out.push(await runCertificationScenario(scenario, env, logger, deps));
  }
  return out;
}
