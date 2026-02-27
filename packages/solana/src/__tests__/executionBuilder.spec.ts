import { describe, expect, it } from 'vitest';
import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  type AddressLookupTableAccount,
  type VersionedTransaction,
} from '@solana/web3.js';
import { SWAP_OK, SWAP_SKIP_DUST_SOL, SWAP_SKIP_DUST_USDC, computeAttestationHash, encodeAttestationPayload } from '@clmm-autopilot/core';
import { buildExitTransaction, type BuildExitConfig, type ExitQuote } from '../executionBuilder';
import { DISABLE_RECEIPT_PROGRAM_FOR_TESTING, RECEIPT_PROGRAM_ID } from '../receipt';

const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const USDC_MINT = new PublicKey('BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k');

const pk = (seed: number) => new PublicKey(new Uint8Array(32).fill(seed));

function ix(seed: number): TransactionInstruction {
  return new TransactionInstruction({ programId: pk(seed), keys: [], data: Buffer.from([seed]) });
}

const baseSnapshot = {
  cluster: 'devnet' as const,
  pairLabel: 'SOL/USDC',
  pairValid: true,
  whirlpool: pk(10),
  position: pk(11),
  positionMint: pk(111),
  currentTickIndex: 100,
  lowerTickIndex: 50,
  upperTickIndex: 150,
  tickSpacing: 1,
  inRange: true,
  liquidity: BigInt(10),
  tokenMintA: SOL_MINT,
  tokenMintB: USDC_MINT,
  tokenDecimalsA: 9,
  tokenDecimalsB: 6,
  tokenVaultA: pk(12),
  tokenVaultB: pk(13),
  tickArrayLower: pk(14),
  tickArrayUpper: pk(15),
  tokenProgramA: pk(16),
  tokenProgramB: pk(17),
  removePreview: null,
  removePreviewReasonCode: 'QUOTE_UNAVAILABLE' as const,
};

type SimResult = { err: unknown | null; logs?: string[]; unitsConsumed?: number; innerInstructions?: unknown; returnData?: unknown };

function buildConfig(overrides?: Partial<BuildExitConfig>): BuildExitConfig {
  const defaultQuote: ExitQuote = {
    inputMint: SOL_MINT,
    outputMint: USDC_MINT,
    inAmount: 123n,
    outAmount: 456n,
    slippageBps: 30,
    quotedAtUnixMs: 1_700_000_000_000,
    raw: { inAmount: '123', outAmount: '456' },
  };

  const authority = pk(18);
  const epochNowMs = 1_700_000_000_500;

  const defaults: BuildExitConfig = {
    authority,
    payer: pk(19),
    recentBlockhash: 'EETubP5AKH2uP8WqzU7xYfPqBrM6oTnP3v8igJE6wz7A',
    computeUnitLimit: 600_000,
    computeUnitPriceMicroLamports: 10_000,
    quote: defaultQuote,
    slippageBpsCap: 50,
    quoteFreshnessMs: 2_000,
    nowUnixMs: () => epochNowMs,
    receiptEpochUnixMs: epochNowMs,
    minSolLamportsToSwap: 0,
    minUsdcMinorToSwap: 0,
    availableLamports: 5_000_000,
    requirements: {
      rentLamports: 2_039_280,
      ataCount: 1,
      txFeeLamports: 20_000,
      priorityFeeLamports: 5_000,
      bufferLamports: 10_000,
      totalRequiredLamports: 2_039_280 + 20_000 + 5_000 + 10_000,
    },
    attestationHash: new Uint8Array(32),
    attestationPayloadBytes: new Uint8Array(240),
    simulate: async (): Promise<SimResult> => ({ err: null, logs: ['ok'] }),
    buildOrcaExitIxs: () => ({
      conditionalAtaIxs: [ix(21), ix(22)],
      removeLiquidityIx: ix(31),
      collectFeesIx: ix(32),
      tokenOwnerAccountA: pk(1),
      tokenOwnerAccountB: pk(2),
      positionTokenAccount: pk(3),
    }),
    buildJupiterSwapIxs: async () => ({ instructions: [ix(33)], lookupTableAddresses: [pk(90)] }),
    buildWsolLifecycleIxs: () => ({ preSwap: [ix(23)], postSwap: [ix(24)], wsolAta: pk(55) }),
    lookupTableAccounts: [] as AddressLookupTableAccount[],
  };

  const merged = { ...defaults, ...overrides } as BuildExitConfig;
  const epoch = Math.floor(merged.receiptEpochUnixMs / 1000 / 86400);
  const attestationInput = {
    cluster: 'devnet' as const,
    authority: merged.authority.toBase58(),
    position: baseSnapshot.position.toBase58(),
    positionMint: baseSnapshot.positionMint.toBase58(),
    whirlpool: baseSnapshot.whirlpool.toBase58(),
    epoch,
    direction: 0 as const,
    tickCurrent: baseSnapshot.currentTickIndex,
    lowerTickIndex: baseSnapshot.lowerTickIndex,
    upperTickIndex: baseSnapshot.upperTickIndex,
    slippageBpsCap: merged.slippageBpsCap,
    quoteInputMint: merged.quote.inputMint.toBase58(),
    quoteOutputMint: merged.quote.outputMint.toBase58(),
    quoteInAmount: merged.quote.inAmount,
    quoteMinOutAmount: merged.quote.outAmount,
    quoteQuotedAtUnixMs: BigInt(merged.quote.quotedAtUnixMs),
    swapPlanned: 1,
    swapExecuted: 1,
    swapReasonCode: SWAP_OK,
  };

  const hasPayloadOverride = Boolean(overrides && Object.prototype.hasOwnProperty.call(overrides, 'attestationPayloadBytes'));
  const hasHashOverride = Boolean(overrides && Object.prototype.hasOwnProperty.call(overrides, 'attestationHash'));
  if (!hasPayloadOverride) merged.attestationPayloadBytes = encodeAttestationPayload(attestationInput);
  if (!hasHashOverride) merged.attestationHash = computeAttestationHash(attestationInput);
  return merged;
}

describe('buildExitTransaction', () => {
  it('builds instruction ordering with receipt final when receipt program is enabled', async () => {
    const result = await buildExitTransaction(baseSnapshot, 'DOWN', buildConfig());
    expect(result).toBeInstanceOf(TransactionMessage);
    const msg = result as TransactionMessage;
    if (DISABLE_RECEIPT_PROGRAM_FOR_TESTING) {
      expect(msg.instructions.some((i) => i.programId.equals(RECEIPT_PROGRAM_ID))).toBe(false);
      return;
    }
    expect(msg.instructions[msg.instructions.length - 1].programId.equals(RECEIPT_PROGRAM_ID)).toBe(true);
  });

  it('accepts matching canonical payload hash + epoch', async () => {
    await expect(buildExitTransaction(baseSnapshot, 'DOWN', buildConfig())).resolves.toBeInstanceOf(TransactionMessage);
  });

  it('rejects zero/missing/mismatched attestation hash', async () => {
    await expect(buildExitTransaction(baseSnapshot, 'DOWN', buildConfig({ attestationHash: new Uint8Array(32) }))).rejects.toMatchObject({
      code: 'MISSING_ATTESTATION_HASH',
    });

    await expect(buildExitTransaction(baseSnapshot, 'DOWN', buildConfig({ attestationPayloadBytes: undefined as unknown as Uint8Array }))).rejects.toMatchObject({
      code: 'MISSING_ATTESTATION_HASH',
    });

    await expect(
      buildExitTransaction(
        baseSnapshot,
        'DOWN',
        buildConfig({ attestationHash: new Uint8Array(32).fill(7), attestationPayloadBytes: new Uint8Array(240).fill(1) }),
      ),
    ).rejects.toMatchObject({ code: 'MISSING_ATTESTATION_HASH' });
  });

  it('rejects canonical field mismatches (direction)', async () => {
    const cfg = buildConfig();
    const payload = cfg.attestationPayloadBytes.slice();
    payload[133] = 1; // direction mismatch for DOWN
    await expect(buildExitTransaction(baseSnapshot, 'DOWN', buildConfig({ attestationPayloadBytes: payload, attestationHash: computeAttestationHash({
      cluster: 'devnet',
      authority: cfg.authority.toBase58(),
      position: baseSnapshot.position.toBase58(),
      positionMint: baseSnapshot.positionMint.toBase58(),
      whirlpool: baseSnapshot.whirlpool.toBase58(),
      epoch: Math.floor(cfg.receiptEpochUnixMs / 1000 / 86400),
      direction: 1,
      tickCurrent: baseSnapshot.currentTickIndex,
      lowerTickIndex: baseSnapshot.lowerTickIndex,
      upperTickIndex: baseSnapshot.upperTickIndex,
      slippageBpsCap: cfg.slippageBpsCap,
      quoteInputMint: cfg.quote.inputMint.toBase58(),
      quoteOutputMint: cfg.quote.outputMint.toBase58(),
      quoteInAmount: cfg.quote.inAmount,
      quoteMinOutAmount: cfg.quote.outAmount,
      quoteQuotedAtUnixMs: BigInt(cfg.quote.quotedAtUnixMs),
      swapPlanned: 1,
      swapExecuted: 1,
      swapReasonCode: SWAP_OK,
    }) }))).rejects.toMatchObject({ code: 'MISSING_ATTESTATION_HASH' });
  });

  it('stale quote fails fast (builder does not rebuild)', async () => {
    const cfg = buildConfig({
      quoteFreshnessMs: 2_000,
      nowUnixMs: () => 1_700_000_000_500,
      quote: { ...buildConfig().quote, quotedAtUnixMs: 1_699_999_990_000 },
    });

    await expect(buildExitTransaction(baseSnapshot, 'DOWN', cfg)).rejects.toMatchObject({ code: 'QUOTE_STALE' });
  });

  it('simulate-then-send gate cannot be bypassed', async () => {
    await expect(
      buildExitTransaction(baseSnapshot, 'DOWN', buildConfig({ simulate: async () => ({ err: new Error('sim err'), logs: ['custom failure'] }) })),
    ).rejects.toMatchObject({ code: 'SIMULATION_FAILED' });
  });

  it('when returnVersioned=true compiles to v0 message', async () => {
    const tx = (await buildExitTransaction(baseSnapshot, 'DOWN', buildConfig({ returnVersioned: true }))) as VersionedTransaction;
    expect(tx.message.version).toBe(0);
  });

  it('dust SOL exposure (DOWN) omits Jupiter and handles receipt flag', async () => {
    const dustQuote = {
      ...buildConfig().quote,
      inAmount: 99n,
      outAmount: 0n,
      quotedAtUnixMs: 1_700_000_000_000,
      raw: undefined,
    };
    const cfg = buildConfig({
      quote: dustQuote,
      minSolLamportsToSwap: 100,
      buildJupiterSwapIxs: async () => {
        throw new Error('jupiter should not be called for dust skip');
      },
      buildWsolLifecycleIxs: () => ({ preSwap: [ix(77)], postSwap: [ix(78)], wsolAta: pk(79) }),
      attestationPayloadBytes: encodeAttestationPayload({
        cluster: 'devnet',
        authority: pk(18).toBase58(),
        position: baseSnapshot.position.toBase58(),
        positionMint: baseSnapshot.positionMint.toBase58(),
        whirlpool: baseSnapshot.whirlpool.toBase58(),
        epoch: Math.floor(1_700_000_000_500 / 1000 / 86400),
        direction: 0,
        tickCurrent: baseSnapshot.currentTickIndex,
        lowerTickIndex: baseSnapshot.lowerTickIndex,
        upperTickIndex: baseSnapshot.upperTickIndex,
        slippageBpsCap: 50,
        quoteInputMint: dustQuote.inputMint.toBase58(),
        quoteOutputMint: dustQuote.outputMint.toBase58(),
        quoteInAmount: dustQuote.inAmount,
        quoteMinOutAmount: dustQuote.outAmount,
        quoteQuotedAtUnixMs: BigInt(dustQuote.quotedAtUnixMs),
        swapPlanned: 1,
        swapExecuted: 0,
        swapReasonCode: SWAP_SKIP_DUST_SOL,
      }),
    });
    cfg.attestationHash = computeAttestationHash({
      cluster: 'devnet',
      authority: pk(18).toBase58(),
      position: baseSnapshot.position.toBase58(),
      positionMint: baseSnapshot.positionMint.toBase58(),
      whirlpool: baseSnapshot.whirlpool.toBase58(),
      epoch: Math.floor(1_700_000_000_500 / 1000 / 86400),
      direction: 0,
      tickCurrent: baseSnapshot.currentTickIndex,
      lowerTickIndex: baseSnapshot.lowerTickIndex,
      upperTickIndex: baseSnapshot.upperTickIndex,
      slippageBpsCap: 50,
      quoteInputMint: dustQuote.inputMint.toBase58(),
      quoteOutputMint: dustQuote.outputMint.toBase58(),
      quoteInAmount: dustQuote.inAmount,
      quoteMinOutAmount: dustQuote.outAmount,
      quoteQuotedAtUnixMs: BigInt(dustQuote.quotedAtUnixMs),
      swapPlanned: 1,
      swapExecuted: 0,
      swapReasonCode: SWAP_SKIP_DUST_SOL,
    });

    const msg = (await buildExitTransaction(baseSnapshot, 'DOWN', cfg)) as TransactionMessage;
    expect(msg.instructions.some((i) => i.programId.equals(pk(33)))).toBe(false);
    expect(msg.instructions.some((i) => i.programId.equals(RECEIPT_PROGRAM_ID))).toBe(!DISABLE_RECEIPT_PROGRAM_FOR_TESTING);

    const execHash = computeAttestationHash({
      cluster: 'devnet',
      authority: pk(18).toBase58(),
      position: baseSnapshot.position.toBase58(),
      positionMint: baseSnapshot.positionMint.toBase58(),
      whirlpool: baseSnapshot.whirlpool.toBase58(),
      epoch: Math.floor(1_700_000_000_500 / 1000 / 86400),
      direction: 0,
      tickCurrent: baseSnapshot.currentTickIndex,
      lowerTickIndex: baseSnapshot.lowerTickIndex,
      upperTickIndex: baseSnapshot.upperTickIndex,
      slippageBpsCap: 50,
      quoteInputMint: dustQuote.inputMint.toBase58(),
      quoteOutputMint: dustQuote.outputMint.toBase58(),
      quoteInAmount: dustQuote.inAmount,
      quoteMinOutAmount: dustQuote.outAmount,
      quoteQuotedAtUnixMs: BigInt(dustQuote.quotedAtUnixMs),
      swapPlanned: 1,
      swapExecuted: 1,
      swapReasonCode: SWAP_OK,
    });
    expect(Buffer.from(execHash).equals(Buffer.from(cfg.attestationHash))).toBe(false);
  });

  it('dust USDC exposure (UP) omits Jupiter and handles receipt flag', async () => {
    const dustQuote = {
      ...buildConfig().quote,
      inputMint: USDC_MINT,
      outputMint: SOL_MINT,
      inAmount: 49n,
      outAmount: 0n,
      quotedAtUnixMs: 1_700_000_000_000,
      raw: undefined,
    };
    const cfg = buildConfig({
      quote: dustQuote,
      minUsdcMinorToSwap: 50,
      buildJupiterSwapIxs: async () => {
        throw new Error('jupiter should not be called for dust skip');
      },
      attestationPayloadBytes: encodeAttestationPayload({
        cluster: 'devnet',
        authority: pk(18).toBase58(),
        position: baseSnapshot.position.toBase58(),
        positionMint: baseSnapshot.positionMint.toBase58(),
        whirlpool: baseSnapshot.whirlpool.toBase58(),
        epoch: Math.floor(1_700_000_000_500 / 1000 / 86400),
        direction: 1,
        tickCurrent: baseSnapshot.currentTickIndex,
        lowerTickIndex: baseSnapshot.lowerTickIndex,
        upperTickIndex: baseSnapshot.upperTickIndex,
        slippageBpsCap: 50,
        quoteInputMint: dustQuote.inputMint.toBase58(),
        quoteOutputMint: dustQuote.outputMint.toBase58(),
        quoteInAmount: dustQuote.inAmount,
        quoteMinOutAmount: dustQuote.outAmount,
        quoteQuotedAtUnixMs: BigInt(dustQuote.quotedAtUnixMs),
        swapPlanned: 1,
        swapExecuted: 0,
        swapReasonCode: SWAP_SKIP_DUST_USDC,
      }),
    });
    cfg.attestationHash = computeAttestationHash({
      cluster: 'devnet',
      authority: pk(18).toBase58(),
      position: baseSnapshot.position.toBase58(),
      positionMint: baseSnapshot.positionMint.toBase58(),
      whirlpool: baseSnapshot.whirlpool.toBase58(),
      epoch: Math.floor(1_700_000_000_500 / 1000 / 86400),
      direction: 1,
      tickCurrent: baseSnapshot.currentTickIndex,
      lowerTickIndex: baseSnapshot.lowerTickIndex,
      upperTickIndex: baseSnapshot.upperTickIndex,
      slippageBpsCap: 50,
      quoteInputMint: dustQuote.inputMint.toBase58(),
      quoteOutputMint: dustQuote.outputMint.toBase58(),
      quoteInAmount: dustQuote.inAmount,
      quoteMinOutAmount: dustQuote.outAmount,
      quoteQuotedAtUnixMs: BigInt(dustQuote.quotedAtUnixMs),
      swapPlanned: 1,
      swapExecuted: 0,
      swapReasonCode: SWAP_SKIP_DUST_USDC,
    });

    const msg = (await buildExitTransaction(baseSnapshot, 'UP', cfg)) as TransactionMessage;
    expect(msg.instructions.some((i) => i.programId.equals(pk(33)))).toBe(false);
    expect(msg.instructions.some((i) => i.programId.equals(RECEIPT_PROGRAM_ID))).toBe(!DISABLE_RECEIPT_PROGRAM_FOR_TESTING);
  });
});
