import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type TransactionInstruction,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { assertSolUsdcPair, hashAttestationPayload, unixDaysFromUnixMs } from '@clmm-autopilot/core';
import { buildCreateAtaIdempotentIx, SOL_MINT } from './ata';
import { fetchJupiterSwapIxs, type JupiterQuote, type JupiterSwapIxs } from './jupiter';
import type { PositionSnapshot } from './orcaInspector';
import { buildOrcaExitIxs, type OrcaExitIxs } from './orcaExitBuilder';
import { buildRecordExecutionIx } from './receipt';
import { classifySimulationFailure, type SimulationDiagnostics } from './simErrors';
import type { CanonicalErrorCode } from './types';
import type { FeeBufferDebugPayload, FeeRequirementsBreakdown } from './requirements';
import { buildWsolLifecycleIxs, type WsolLifecycle } from './wsol';

export type ExitDirection = 'DOWN' | 'UP';

// Phase-1 canonical quote type used by the execution builder.
export type ExitQuote = Pick<JupiterQuote, 'inputMint' | 'outputMint' | 'inAmount' | 'outAmount' | 'slippageBps' | 'quotedAtUnixMs'> & {
  raw?: JupiterQuote['raw'];
};

export type BuildExitConfig = {
  authority: PublicKey;
  payer: PublicKey;
  recentBlockhash: string;

  computeUnitLimit?: number;
  computeUnitPriceMicroLamports?: number;

  // Quote + guardrails.
  quote: ExitQuote;
  slippageBpsCap: number;
  quoteFreshnessMs: number;
  nowUnixMs: () => number;
  receiptEpochUnixMs: number;

  // Cost guardrails.
  availableLamports: number;
  requirements: FeeRequirementsBreakdown;

  // Receipt.
  attestationHash: Uint8Array;
  attestationPayloadBytes: Uint8Array;

  // Builder deps (override in tests). Defaults construct real Orca/Jupiter/WSOL modules.
  buildOrcaExitIxs?: (args: { snapshot: PositionSnapshot; authority: PublicKey; payer: PublicKey }) => OrcaExitIxs;
  buildJupiterSwapIxs?: (args: { quote: ExitQuote; authority: PublicKey }) => Promise<JupiterSwapIxs>;
  buildWsolLifecycleIxs?: (args: { quote: ExitQuote; authority: PublicKey; payer: PublicKey }) => WsolLifecycle;

  lookupTableAccounts?: AddressLookupTableAccount[];

  // Mandatory simulation gate (must be run against the exact tx message that will be signed).
  simulate: (tx: VersionedTransaction) => Promise<SimulationDiagnostics>;

  returnVersioned?: boolean;
};

export type BuildExitResult = VersionedTransaction | TransactionMessage;

type TypedError = Error & { code: CanonicalErrorCode; retryable: boolean; debug?: unknown };

function fail(code: CanonicalErrorCode, message: string, retryable: boolean, debug?: unknown): never {
  const err = new Error(message) as TypedError;
  err.code = code;
  err.retryable = retryable;
  if (debug !== undefined) err.debug = debug;
  throw err;
}

function canonicalEpoch(unixMs: number): number {
  return unixDaysFromUnixMs(unixMs);
}

function epochFromPayloadBytes(payload: Uint8Array): number {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  // cluster(1) + authority(32) + position(32) + positionMint(32) + whirlpool(32) = 129
  return view.getUint32(129, true);
}

function u8At(payload: Uint8Array, offset: number): number {
  return payload[offset] ?? 0;
}

function i32leAt(payload: Uint8Array, offset: number): number {
  return new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getInt32(offset, true);
}

function u16leAt(payload: Uint8Array, offset: number): number {
  return new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint16(offset, true);
}

function u64leAt(payload: Uint8Array, offset: number): bigint {
  const slice = payload.subarray(offset, offset + 8);
  let n = BigInt(0);
  for (let i = 7; i >= 0; i -= 1) {
    n = (n << BigInt(8)) | BigInt(slice[i] ?? 0);
  }
  return n;
}

function bytesEqualConstantTime(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

function fieldEq32(payload: Uint8Array, offset: number, expected: Uint8Array): boolean {
  if (expected.length !== 32) return false;
  const got = payload.subarray(offset, offset + 32);
  return bytesEqualConstantTime(got, expected);
}

function hex32At(payload: Uint8Array, offset: number): string {
  return Buffer.from(payload.subarray(offset, offset + 32)).toString('hex');
}

function failMismatch(field: string, expected: unknown, actual: unknown): never {
  fail('MISSING_ATTESTATION_HASH', `attestation payload ${field} mismatch`, false, { expected, actual });
}

function assertQuoteDirection(direction: ExitDirection, quote: ExitQuote, snapshot: PositionSnapshot): void {
  const nonSolMint = snapshot.tokenMintA.equals(SOL_MINT) ? snapshot.tokenMintB : snapshot.tokenMintA;

  if (direction === 'DOWN') {
    if (!quote.inputMint.equals(SOL_MINT) || !quote.outputMint.equals(nonSolMint)) {
      fail('NOT_SOL_USDC', 'DOWN direction must route SOL->USDC-side mint from snapshot', false);
    }
    return;
  }

  if (!quote.inputMint.equals(nonSolMint) || !quote.outputMint.equals(SOL_MINT)) {
    fail('NOT_SOL_USDC', 'UP direction must route USDC-side mint from snapshot->SOL', false);
  }
}

function enforceFeeBuffer(cfg: BuildExitConfig): void {
  const required = cfg.requirements.totalRequiredLamports;
  if (cfg.availableLamports < required) {
    const deficitLamports = required - cfg.availableLamports;
    const debug: FeeBufferDebugPayload = {
      availableLamports: cfg.availableLamports,
      requirements: cfg.requirements,
      deficitLamports,
      notes: [
        'requirements.totalRequiredLamports = rentLamports + txFeeLamports + priorityFeeLamports + bufferLamports',
        'rentLamports is derived from missing ATA count * rent exemption for token account size',
      ],
    };
    fail('INSUFFICIENT_FEE_BUFFER', 'Insufficient lamports for projected execution costs + fee buffer', false, debug);
  }
}

function buildComputeBudgetIxs(cfg: BuildExitConfig): TransactionInstruction[] {
  if (cfg.computeUnitLimit === undefined || cfg.computeUnitPriceMicroLamports === undefined) return [];
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cfg.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cfg.computeUnitPriceMicroLamports }),
  ];
}

function tokenProgramForMint(mint: PublicKey, snapshot: PositionSnapshot): PublicKey {
  if (mint.equals(snapshot.tokenMintA)) return snapshot.tokenProgramA;
  if (mint.equals(snapshot.tokenMintB)) return snapshot.tokenProgramB;
  return TOKEN_PROGRAM_ID;
}

export async function buildExitTransaction(
  snapshot: PositionSnapshot,
  direction: ExitDirection,
  config: BuildExitConfig,
): Promise<BuildExitResult> {
  if (config.attestationHash.length !== 32) {
    fail('MISSING_ATTESTATION_HASH', 'attestationHash must be exactly 32 bytes', false);
  }
  if (config.attestationHash.every((b) => b === 0)) {
    fail('MISSING_ATTESTATION_HASH', 'attestationHash must be non-zero', false);
  }
  if (!config.attestationPayloadBytes || config.attestationPayloadBytes.length === 0) {
    fail('MISSING_ATTESTATION_HASH', 'attestationPayloadBytes are required', false);
  }
  if (config.attestationPayloadBytes.length !== 236) {
    fail('MISSING_ATTESTATION_HASH', 'attestationPayloadBytes must be canonical fixed-width length (236 bytes)', false, {
      got: config.attestationPayloadBytes.length,
      expected: 236,
    });
  }
  const expected = hashAttestationPayload(config.attestationPayloadBytes);
  if (!bytesEqualConstantTime(expected, config.attestationHash)) {
    fail('MISSING_ATTESTATION_HASH', 'attestationHash must equal sha256(attestationPayloadBytes)', false);
  }
  const payloadEpoch = epochFromPayloadBytes(config.attestationPayloadBytes);
  const receiptEpoch = canonicalEpoch(config.receiptEpochUnixMs);
  if (payloadEpoch !== receiptEpoch) {
    fail('MISSING_ATTESTATION_HASH', 'attestation payload epoch must match canonical receipt epoch', false, {
      payloadEpoch,
      receiptEpoch,
    });
  }

  // Semantic attestation binding (M9 canonical payload fields) to this concrete execution intent.
  const payload = config.attestationPayloadBytes;
  const expectedDirection = direction === 'DOWN' ? 0 : 1;
  const expectedCluster = snapshot.cluster === 'devnet' ? 0 : snapshot.cluster === 'mainnet-beta' ? 1 : 2;

  if (u8At(payload, 0) !== expectedCluster) {
    failMismatch('cluster', expectedCluster, u8At(payload, 0));
  }
  if (!fieldEq32(payload, 1, config.authority.toBuffer())) {
    failMismatch('authority', config.authority.toBase58(), hex32At(payload, 1));
  }

  assertSolUsdcPair(snapshot.tokenMintA.toBase58(), snapshot.tokenMintB.toBase58(), snapshot.cluster);

  const quote = config.quote;
  if (config.nowUnixMs() - quote.quotedAtUnixMs > config.quoteFreshnessMs) {
    fail('QUOTE_STALE', 'Quote is stale', true, {
      quoteAgeMs: config.nowUnixMs() - quote.quotedAtUnixMs,
      quoteFreshnessMs: config.quoteFreshnessMs,
    });
  }

  if (!fieldEq32(payload, 33, snapshot.position.toBuffer())) {
    failMismatch('position', snapshot.position.toBase58(), hex32At(payload, 33));
  }
  if (!fieldEq32(payload, 65, snapshot.positionMint.toBuffer())) {
    failMismatch('positionMint', snapshot.positionMint.toBase58(), hex32At(payload, 65));
  }
  if (!fieldEq32(payload, 97, snapshot.whirlpool.toBuffer())) {
    failMismatch('whirlpool', snapshot.whirlpool.toBase58(), hex32At(payload, 97));
  }
  if (u8At(payload, 133) !== expectedDirection) {
    failMismatch('direction', expectedDirection, u8At(payload, 133));
  }
  if (i32leAt(payload, 134) !== snapshot.currentTickIndex) {
    failMismatch('tickCurrent', snapshot.currentTickIndex, i32leAt(payload, 134));
  }
  if (i32leAt(payload, 138) !== snapshot.lowerTickIndex) {
    failMismatch('lowerTickIndex', snapshot.lowerTickIndex, i32leAt(payload, 138));
  }
  if (i32leAt(payload, 142) !== snapshot.upperTickIndex) {
    failMismatch('upperTickIndex', snapshot.upperTickIndex, i32leAt(payload, 142));
  }
  if (u16leAt(payload, 146) !== config.slippageBpsCap) {
    failMismatch('slippageBpsCap', config.slippageBpsCap, u16leAt(payload, 146));
  }

  assertQuoteDirection(direction, quote, snapshot);

  if (!fieldEq32(payload, 148, quote.inputMint.toBuffer())) {
    failMismatch('quote.inputMint', quote.inputMint.toBase58(), hex32At(payload, 148));
  }
  if (!fieldEq32(payload, 180, quote.outputMint.toBuffer())) {
    failMismatch('quote.outputMint', quote.outputMint.toBase58(), hex32At(payload, 180));
  }
  if (u64leAt(payload, 212) !== quote.inAmount) {
    failMismatch('quote.inAmount', quote.inAmount.toString(), u64leAt(payload, 212).toString());
  }
  if (u64leAt(payload, 220) !== quote.outAmount) {
    failMismatch('quote.minOutAmount', quote.outAmount.toString(), u64leAt(payload, 220).toString());
  }
  if (u64leAt(payload, 228) !== BigInt(quote.quotedAtUnixMs)) {
    failMismatch('quote.quotedAtUnixMs', quote.quotedAtUnixMs, Number(u64leAt(payload, 228)));
  }

  if (quote.slippageBps > config.slippageBpsCap) {
    fail('SLIPPAGE_EXCEEDED', 'Quote slippage exceeds configured cap', false);
  }

  enforceFeeBuffer(config);

  const buildOrca = config.buildOrcaExitIxs ?? buildOrcaExitIxs;
  const orca = buildOrca({ snapshot, authority: config.authority, payer: config.payer });

  const buildJup =
    config.buildJupiterSwapIxs ??
    (async ({ quote, authority }: { quote: ExitQuote; authority: PublicKey }) => {
      if (!quote.raw) throw new Error('quote.raw required for default Jupiter swap builder');
      return fetchJupiterSwapIxs({ quote: quote as JupiterQuote, userPublicKey: authority, wrapAndUnwrapSol: false });
    });
  const jup = await buildJup({ quote, authority: config.authority });

  const buildWsol =
    config.buildWsolLifecycleIxs ??
    (({ quote, authority, payer }: { quote: ExitQuote; authority: PublicKey; payer: PublicKey }) =>
      buildWsolLifecycleIxs({
        authority,
        payer,
        inputMint: quote.inputMint,
        outputMint: quote.outputMint,
        wrapLamports: quote.inputMint.equals(SOL_MINT) ? quote.inAmount : undefined,
      }));

  const wsolLifecycle = buildWsol({ quote, authority: config.authority, payer: config.payer });
  const wsolRequired = quote.inputMint.equals(SOL_MINT) || quote.outputMint.equals(SOL_MINT);

  // Ensure Jupiter input/output ATAs exist (idempotent). If the mint is the pool mint, we use the pool's token program.
  const jupiterAtaIxs: TransactionInstruction[] = [];
  if (!quote.inputMint.equals(SOL_MINT)) {
    jupiterAtaIxs.push(
      buildCreateAtaIdempotentIx({
        payer: config.payer,
        owner: config.authority,
        mint: quote.inputMint,
        tokenProgramId: tokenProgramForMint(quote.inputMint, snapshot),
      }).ix,
    );
  }
  if (!quote.outputMint.equals(SOL_MINT)) {
    jupiterAtaIxs.push(
      buildCreateAtaIdempotentIx({
        payer: config.payer,
        owner: config.authority,
        mint: quote.outputMint,
        tokenProgramId: tokenProgramForMint(quote.outputMint, snapshot),
      }).ix,
    );
  }

  const receiptIx = buildRecordExecutionIx({
    authority: config.authority,
    positionMint: snapshot.positionMint,
    epoch: canonicalEpoch(config.receiptEpochUnixMs),
    direction: direction === 'DOWN' ? 0 : 1,
    attestationHash: config.attestationHash,
  });

  const instructions: TransactionInstruction[] = [
    ...buildComputeBudgetIxs(config),
    ...orca.conditionalAtaIxs,
    ...jupiterAtaIxs,
    ...(wsolRequired ? wsolLifecycle.preSwap : []),
    orca.removeLiquidityIx,
    orca.collectFeesIx,
    ...jup.instructions,
    ...(wsolRequired ? wsolLifecycle.postSwap : []),
    receiptIx,
  ];

  const message = new TransactionMessage({
    payerKey: config.payer,
    recentBlockhash: config.recentBlockhash,
    instructions,
  });

  const v0 = message.compileToV0Message(config.lookupTableAccounts ?? []);
  const tx = new VersionedTransaction(v0);

  const simulation = await config.simulate(tx);
  if (simulation.err !== null) {
    const mapped = classifySimulationFailure(simulation);
    fail(mapped.code, mapped.message, false, mapped.debug);
  }

  if (config.returnVersioned) return tx;
  return message;
}
