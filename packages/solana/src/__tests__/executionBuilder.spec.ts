import { describe, expect, it, vi } from 'vitest';
import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  type AddressLookupTableAccount,
  type VersionedTransaction,
} from '@solana/web3.js';
import { computeAttestationHash, encodeAttestationPayload } from '@clmm-autopilot/core';
import { buildExitTransaction, type BuildExitConfig, type ExitQuote } from '../executionBuilder';

const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const USDC_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

const pk = (seed: number) => new PublicKey(new Uint8Array(32).fill(seed));

function ix(seed: number): TransactionInstruction {
  return new TransactionInstruction({
    programId: pk(seed),
    keys: [],
    data: Buffer.from([seed]),
  });
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

const attestationHash = new Uint8Array(32).fill(7);
const attestationPayloadBytes = new Uint8Array(68);

type SimResult = { err: unknown | null; logs?: string[]; unitsConsumed?: number; innerInstructions?: unknown; returnData?: unknown };

function buildConfig(overrides?: Partial<BuildExitConfig>): BuildExitConfig {
  const defaultQuote: ExitQuote = {
    inputMint: SOL_MINT,
    outputMint: USDC_MINT,
    inAmount: BigInt(123),
    outAmount: BigInt(456),
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
    maxSlippageBps: 50,
    quoteFreshnessMs: 2_000,
    maxRebuildAttempts: 3,
    nowUnixMs: () => epochNowMs,
    receiptEpochUnixMs: epochNowMs,
    rebuildSnapshotAndQuote: async () => ({ snapshot: baseSnapshot, quote: { ...defaultQuote, quotedAtUnixMs: 1_700_000_000_200 } }),
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
    attestationPayloadBytes: new Uint8Array(217),
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
  const autoInput = {
    authority: merged.authority.toBase58(),
    positionMint: baseSnapshot.positionMint.toBase58(),
    epoch,
    direction: 0 as const,
    lowerTickIndex: baseSnapshot.lowerTickIndex,
    upperTickIndex: baseSnapshot.upperTickIndex,
    currentTickIndex: baseSnapshot.currentTickIndex,
    observedSlot: 1n,
    observedUnixTs: 1n,
    quoteInputMint: merged.quote.inputMint.toBase58(),
    quoteOutputMint: merged.quote.outputMint.toBase58(),
    quoteInAmount: merged.quote.inAmount,
    quoteOutAmount: merged.quote.outAmount,
    quoteSlippageBps: merged.quote.slippageBps,
    quoteQuotedAtUnixMs: BigInt(merged.quote.quotedAtUnixMs),
    computeUnitLimit: merged.computeUnitLimit,
    computeUnitPriceMicroLamports: BigInt(merged.computeUnitPriceMicroLamports),
    maxSlippageBps: merged.maxSlippageBps,
    quoteFreshnessMs: BigInt(merged.quoteFreshnessMs),
    maxRebuildAttempts: merged.maxRebuildAttempts,
  };

  const hasPayloadOverride = Boolean(overrides && Object.prototype.hasOwnProperty.call(overrides, 'attestationPayloadBytes'));
  const hasHashOverride = Boolean(overrides && Object.prototype.hasOwnProperty.call(overrides, 'attestationHash'));
  if (!hasPayloadOverride) merged.attestationPayloadBytes = encodeAttestationPayload(autoInput);
  if (!hasHashOverride) merged.attestationHash = computeAttestationHash(autoInput);
  return merged;
}

describe('buildExitTransaction', () => {
  it('builds instruction ordering with receipt final and canonical epoch', async () => {
    const config = buildConfig();
    const result = await buildExitTransaction(baseSnapshot, 'DOWN', config);
    expect(result).toBeInstanceOf(TransactionMessage);

    const msg = result as TransactionMessage;
    const order = msg.instructions.map((i) => i.programId.toBase58());

    // compute budget x2, orca ATA x2, jup ATA x1(USDC), wsol lifecycle x1, remove, collect, swap, wsol close, receipt(final)
    // Note: quote input is SOL -> no input ATA created.
    expect(order.length).toBeGreaterThanOrEqual(9);

    // Ensure our injected seeds are in correct relative order.
    const ids = msg.instructions.map((i) => i.programId.toBase58());
    const idx23 = ids.indexOf(pk(23).toBase58());
    const idx31 = ids.indexOf(pk(31).toBase58());
    const idx32 = ids.indexOf(pk(32).toBase58());
    const idx33 = ids.indexOf(pk(33).toBase58());
    const idx24 = ids.indexOf(pk(24).toBase58());

    expect(idx23).toBeGreaterThan(-1);
    expect(idx31).toBeGreaterThan(idx23);
    expect(idx32).toBeGreaterThan(idx31);
    expect(idx33).toBeGreaterThan(idx32);
    expect(idx24).toBeGreaterThan(idx33);

    const finalIx = msg.instructions[msg.instructions.length - 1];
    expect(finalIx.data.length).toBe(77);
    const epoch = finalIx.data.readUInt32LE(8);
    expect(epoch).toBe(Math.floor(config.nowUnixMs() / 1000 / 86400));
  });

  it('tight slippage aborts safely without rebuild attempts', async () => {
    const rebuildSpy = vi.fn(async () => ({ snapshot: baseSnapshot, quote: buildConfig().quote }));
    await expect(
      buildExitTransaction(
        baseSnapshot,
        'DOWN',
        buildConfig({ quote: { ...buildConfig().quote, slippageBps: 55 }, rebuildSnapshotAndQuote: rebuildSpy }),
      ),
    ).rejects.toMatchObject({ code: 'SLIPPAGE_EXCEEDED' });
    expect(rebuildSpy).toHaveBeenCalledTimes(0);
  });

  it('stale quote triggers deterministic rebuild path and fails attestation mismatch', async () => {
    const rebuiltQuote: ExitQuote = {
      ...buildConfig().quote,
      quotedAtUnixMs: 1_700_000_000_400,
    };
    const rebuildSpy = vi.fn(async () => ({ snapshot: baseSnapshot, quote: rebuiltQuote }));
    const config = buildConfig({ quote: { ...buildConfig().quote, quotedAtUnixMs: 1_699_999_990_000 }, rebuildSnapshotAndQuote: rebuildSpy });

    await expect(buildExitTransaction(baseSnapshot, 'DOWN', config)).rejects.toMatchObject({ code: 'MISSING_ATTESTATION_HASH' });
    expect(rebuildSpy).toHaveBeenCalledTimes(1);
  });

  it('stale rebuild loop stops on 15s window with live clock', async () => {
    let now = 1_700_000_000_500;
    const nowFn = () => {
      now += 4_000;
      return now;
    };

    const rebuildSpy = vi.fn(async () => ({
      snapshot: baseSnapshot,
      quote: { ...buildConfig().quote, quotedAtUnixMs: 1_699_999_900_000 },
    }));

    await expect(
      buildExitTransaction(
        baseSnapshot,
        'DOWN',
        buildConfig({
          nowUnixMs: nowFn,
          quote: { ...buildConfig().quote, quotedAtUnixMs: 1_699_999_900_000 },
          rebuildSnapshotAndQuote: rebuildSpy,
          maxRebuildAttempts: 99,
        }),
      ),
    ).rejects.toMatchObject({ code: 'QUOTE_STALE' });
    expect(rebuildSpy).toHaveBeenCalled();
  });

  it('simulate-then-send gate cannot be bypassed', async () => {
    await expect(
      buildExitTransaction(
        baseSnapshot,
        'DOWN',
        buildConfig({ simulate: async () => ({ err: new Error('sim err'), logs: ['custom failure'] }) }),
      ),
    ).rejects.toMatchObject({ code: 'SIMULATION_FAILED', debug: { logs: ['custom failure'] } });
  });

  it('maps missing-account simulation failures to canonical data-unavailable', async () => {
    await expect(
      buildExitTransaction(
        baseSnapshot,
        'DOWN',
        buildConfig({ simulate: async () => ({ err: 'AccountNotFound', logs: ['could not find account'] }) }),
      ),
    ).rejects.toMatchObject({ code: 'DATA_UNAVAILABLE' });
  });

  it('builder output is deterministic for fixed snapshot + quote', async () => {
    const config = buildConfig();
    const a = (await buildExitTransaction(baseSnapshot, 'DOWN', config)) as TransactionMessage;
    const b = (await buildExitTransaction(baseSnapshot, 'DOWN', config)) as TransactionMessage;

    const normalize = (m: TransactionMessage) =>
      m.instructions.map((ixx) => `${ixx.programId.toBase58()}:${Buffer.from(ixx.data).toString('hex')}`);

    expect(normalize(a)).toEqual(normalize(b));
  });

  it('when returnVersioned=true compiles to v0 message', async () => {
    const tx = (await buildExitTransaction(baseSnapshot, 'DOWN', buildConfig({ returnVersioned: true }))) as VersionedTransaction;
    expect(tx.message.version).toBe(0);
  });

  it('fails underfunded with canonical code and structured debug payload', async () => {
    await expect(
      buildExitTransaction(
        baseSnapshot,
        'DOWN',
        buildConfig({
          availableLamports: 1,
          requirements: {
            rentLamports: 2,
            ataCount: 1,
            txFeeLamports: 3,
            priorityFeeLamports: 4,
            bufferLamports: 5,
            totalRequiredLamports: 14,
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_FEE_BUFFER',
      debug: {
        availableLamports: 1,
        deficitLamports: 13,
        requirements: { totalRequiredLamports: 14 },
      },
    });
  });

  it('fails fast with NOT_SOL_USDC when snapshot pair is not SOL/USDC', async () => {
    await expect(
      buildExitTransaction(
        {
          ...baseSnapshot,
          tokenMintB: pk(88),
        },
        'DOWN',
        buildConfig(),
      ),
    ).rejects.toMatchObject({ code: 'NOT_SOL_USDC' });
  });

  it('enforces deterministic direction-to-target swap intent', async () => {
    await expect(
      buildExitTransaction(
        baseSnapshot,
        'DOWN',
        buildConfig({
          quote: {
            ...buildConfig().quote,
            inputMint: USDC_MINT,
            outputMint: SOL_MINT,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_SOL_USDC' });

    const epochNowMs = 1_700_000_000_500;
    const upInput = {
      authority: buildConfig().authority.toBase58(),
      positionMint: baseSnapshot.positionMint.toBase58(),
      epoch: Math.floor(epochNowMs / 1000 / 86400),
      direction: 1 as const,
      lowerTickIndex: baseSnapshot.lowerTickIndex,
      upperTickIndex: baseSnapshot.upperTickIndex,
      currentTickIndex: baseSnapshot.currentTickIndex,
      observedSlot: 1n,
      observedUnixTs: 1n,
      quoteInputMint: SOL_MINT.toBase58(),
      quoteOutputMint: USDC_MINT.toBase58(),
      quoteInAmount: 123n,
      quoteOutAmount: 456n,
      quoteSlippageBps: 30,
      quoteQuotedAtUnixMs: 1_700_000_000_000n,
      computeUnitLimit: 600_000,
      computeUnitPriceMicroLamports: 10_000n,
      maxSlippageBps: 50,
      quoteFreshnessMs: 2_000n,
      maxRebuildAttempts: 3,
    };

    await expect(
      buildExitTransaction(
        baseSnapshot,
        'UP',
        buildConfig({
          nowUnixMs: () => epochNowMs,
          attestationPayloadBytes: encodeAttestationPayload(upInput),
          attestationHash: computeAttestationHash(upInput),
          quote: {
            ...buildConfig().quote,
            inputMint: SOL_MINT,
            outputMint: USDC_MINT,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_SOL_USDC' });
  });

  it('accepts matching attestation payload hash + epoch', async () => {
    const epochNowMs = 1_700_000_000_500;
    const epoch = Math.floor(epochNowMs / 1000 / 86400);
    const payload = encodeAttestationPayload({
      authority: buildConfig().authority.toBase58(),
      positionMint: baseSnapshot.positionMint.toBase58(),
      epoch,
      direction: 0,
      lowerTickIndex: baseSnapshot.lowerTickIndex,
      upperTickIndex: baseSnapshot.upperTickIndex,
      currentTickIndex: baseSnapshot.currentTickIndex,
      observedSlot: 1n,
      observedUnixTs: 1n,
      quoteInputMint: SOL_MINT.toBase58(),
      quoteOutputMint: USDC_MINT.toBase58(),
      quoteInAmount: 123n,
      quoteOutAmount: 456n,
      quoteSlippageBps: 30,
      quoteQuotedAtUnixMs: 1_700_000_000_000n,
      computeUnitLimit: 600_000,
      computeUnitPriceMicroLamports: 10_000n,
      maxSlippageBps: 50,
      quoteFreshnessMs: 2_000n,
      maxRebuildAttempts: 3,
    });
    const hash = computeAttestationHash({
      authority: buildConfig().authority.toBase58(),
      positionMint: baseSnapshot.positionMint.toBase58(),
      epoch,
      direction: 0,
      lowerTickIndex: baseSnapshot.lowerTickIndex,
      upperTickIndex: baseSnapshot.upperTickIndex,
      currentTickIndex: baseSnapshot.currentTickIndex,
      observedSlot: 1n,
      observedUnixTs: 1n,
      quoteInputMint: SOL_MINT.toBase58(),
      quoteOutputMint: USDC_MINT.toBase58(),
      quoteInAmount: 123n,
      quoteOutAmount: 456n,
      quoteSlippageBps: 30,
      quoteQuotedAtUnixMs: 1_700_000_000_000n,
      computeUnitLimit: 600_000,
      computeUnitPriceMicroLamports: 10_000n,
      maxSlippageBps: 50,
      quoteFreshnessMs: 2_000n,
      maxRebuildAttempts: 3,
    });

    await expect(
      buildExitTransaction(baseSnapshot, 'DOWN', buildConfig({ nowUnixMs: () => epochNowMs, attestationHash: hash, attestationPayloadBytes: payload })),
    ).resolves.toBeInstanceOf(TransactionMessage);
  });

  it('rejects missing/zero/mismatched attestation hash', async () => {
    await expect(buildExitTransaction(baseSnapshot, 'DOWN', buildConfig({ attestationPayloadBytes: undefined as unknown as Uint8Array }))).rejects.toMatchObject({
      code: 'MISSING_ATTESTATION_HASH',
    });

    await expect(buildExitTransaction(baseSnapshot, 'DOWN', buildConfig({ attestationPayloadBytes: new Uint8Array(67) }))).rejects.toMatchObject({
      code: 'MISSING_ATTESTATION_HASH',
    });

    await expect(buildExitTransaction(baseSnapshot, 'DOWN', buildConfig({ attestationPayloadBytes: new Uint8Array(218) }))).rejects.toMatchObject({
      code: 'MISSING_ATTESTATION_HASH',
    });

    await expect(buildExitTransaction(baseSnapshot, 'DOWN', buildConfig({ attestationHash: new Uint8Array(31) }))).rejects.toMatchObject({
      code: 'MISSING_ATTESTATION_HASH',
    });

    await expect(buildExitTransaction(baseSnapshot, 'DOWN', buildConfig({ attestationHash: new Uint8Array(32) }))).rejects.toMatchObject({
      code: 'MISSING_ATTESTATION_HASH',
    });

    await expect(
      buildExitTransaction(
        baseSnapshot,
        'DOWN',
        buildConfig({
          attestationHash,
          attestationPayloadBytes,
        }),
      ),
    ).rejects.toMatchObject({ code: 'MISSING_ATTESTATION_HASH' });

    const epochNowMs = 1_700_000_000_500;
    const badEpochPayload = encodeAttestationPayload({
      authority: buildConfig().authority.toBase58(),
      positionMint: baseSnapshot.positionMint.toBase58(),
      epoch: 1,
      direction: 0,
      lowerTickIndex: baseSnapshot.lowerTickIndex,
      upperTickIndex: baseSnapshot.upperTickIndex,
      currentTickIndex: baseSnapshot.currentTickIndex,
      observedSlot: 1n,
      observedUnixTs: 1n,
      quoteInputMint: SOL_MINT.toBase58(),
      quoteOutputMint: USDC_MINT.toBase58(),
      quoteInAmount: 123n,
      quoteOutAmount: 456n,
      quoteSlippageBps: 30,
      quoteQuotedAtUnixMs: 1_700_000_000_000n,
      computeUnitLimit: 600_000,
      computeUnitPriceMicroLamports: 10_000n,
      maxSlippageBps: 50,
      quoteFreshnessMs: 2_000n,
      maxRebuildAttempts: 3,
    });
    const badEpochHash = computeAttestationHash({
      authority: buildConfig().authority.toBase58(),
      positionMint: baseSnapshot.positionMint.toBase58(),
      epoch: 1,
      direction: 0,
      lowerTickIndex: baseSnapshot.lowerTickIndex,
      upperTickIndex: baseSnapshot.upperTickIndex,
      currentTickIndex: baseSnapshot.currentTickIndex,
      observedSlot: 1n,
      observedUnixTs: 1n,
      quoteInputMint: SOL_MINT.toBase58(),
      quoteOutputMint: USDC_MINT.toBase58(),
      quoteInAmount: 123n,
      quoteOutAmount: 456n,
      quoteSlippageBps: 30,
      quoteQuotedAtUnixMs: 1_700_000_000_000n,
      computeUnitLimit: 600_000,
      computeUnitPriceMicroLamports: 10_000n,
      maxSlippageBps: 50,
      quoteFreshnessMs: 2_000n,
      maxRebuildAttempts: 3,
    });

    await expect(
      buildExitTransaction(
        baseSnapshot,
        'DOWN',
        buildConfig({ nowUnixMs: () => epochNowMs, attestationHash: badEpochHash, attestationPayloadBytes: badEpochPayload }),
      ),
    ).rejects.toMatchObject({ code: 'MISSING_ATTESTATION_HASH' });

    const mismatchAuthorityInput = {
      authority: pk(99).toBase58(),
      positionMint: baseSnapshot.positionMint.toBase58(),
      epoch: Math.floor(epochNowMs / 1000 / 86400),
      direction: 0 as const,
      lowerTickIndex: baseSnapshot.lowerTickIndex,
      upperTickIndex: baseSnapshot.upperTickIndex,
      currentTickIndex: baseSnapshot.currentTickIndex,
      observedSlot: 1n,
      observedUnixTs: 1n,
      quoteInputMint: SOL_MINT.toBase58(),
      quoteOutputMint: USDC_MINT.toBase58(),
      quoteInAmount: 123n,
      quoteOutAmount: 456n,
      quoteSlippageBps: 30,
      quoteQuotedAtUnixMs: 1_700_000_000_000n,
      computeUnitLimit: 600_000,
      computeUnitPriceMicroLamports: 10_000n,
      maxSlippageBps: 50,
      quoteFreshnessMs: 2_000n,
      maxRebuildAttempts: 3,
    };

    await expect(
      buildExitTransaction(
        baseSnapshot,
        'DOWN',
        buildConfig({
          nowUnixMs: () => epochNowMs,
          attestationPayloadBytes: encodeAttestationPayload(mismatchAuthorityInput),
          attestationHash: computeAttestationHash(mismatchAuthorityInput),
        }),
      ),
    ).rejects.toMatchObject({ code: 'MISSING_ATTESTATION_HASH' });

    const mismatchDirectionInput = {
      ...mismatchAuthorityInput,
      authority: buildConfig().authority.toBase58(),
      direction: 1 as const,
    };

    await expect(
      buildExitTransaction(
        baseSnapshot,
        'DOWN',
        buildConfig({
          nowUnixMs: () => epochNowMs,
          attestationPayloadBytes: encodeAttestationPayload(mismatchDirectionInput),
          attestationHash: computeAttestationHash(mismatchDirectionInput),
        }),
      ),
    ).rejects.toMatchObject({ code: 'MISSING_ATTESTATION_HASH' });

    const mismatchQuoteInput = {
      ...mismatchDirectionInput,
      direction: 0 as const,
      quoteInputMint: pk(77).toBase58(),
    };

    await expect(
      buildExitTransaction(
        baseSnapshot,
        'DOWN',
        buildConfig({
          nowUnixMs: () => epochNowMs,
          attestationPayloadBytes: encodeAttestationPayload(mismatchQuoteInput),
          attestationHash: computeAttestationHash(mismatchQuoteInput),
        }),
      ),
    ).rejects.toMatchObject({ code: 'MISSING_ATTESTATION_HASH' });
  });

  it('rejects attestation when rebuilt quote differs from payload-bound quote', async () => {
    const cfg = buildConfig({
      quote: { ...buildConfig().quote, quotedAtUnixMs: 1_699_999_000_000 },
      rebuildSnapshotAndQuote: async () => ({
        snapshot: baseSnapshot,
        quote: { ...buildConfig().quote, quotedAtUnixMs: 1_700_000_000_250, inAmount: 999n },
      }),
    });

    await expect(buildExitTransaction(baseSnapshot, 'DOWN', cfg)).rejects.toMatchObject({ code: 'MISSING_ATTESTATION_HASH' });
  });

  it('rejects mismatches for compute + guardrail fields', async () => {
    const epochNowMs = 1_700_000_000_500;
    const base = {
      authority: buildConfig().authority.toBase58(),
      positionMint: baseSnapshot.positionMint.toBase58(),
      epoch: Math.floor(epochNowMs / 1000 / 86400),
      direction: 0 as const,
      lowerTickIndex: baseSnapshot.lowerTickIndex,
      upperTickIndex: baseSnapshot.upperTickIndex,
      currentTickIndex: baseSnapshot.currentTickIndex,
      observedSlot: 1n,
      observedUnixTs: 1n,
      quoteInputMint: SOL_MINT.toBase58(),
      quoteOutputMint: USDC_MINT.toBase58(),
      quoteInAmount: 123n,
      quoteOutAmount: 456n,
      quoteSlippageBps: 30,
      quoteQuotedAtUnixMs: 1_700_000_000_000n,
      computeUnitLimit: 600_000,
      computeUnitPriceMicroLamports: 10_000n,
      maxSlippageBps: 50,
      quoteFreshnessMs: 2_000n,
      maxRebuildAttempts: 3,
    };

    for (const mutated of [
      { ...base, computeUnitLimit: 600_001 },
      { ...base, computeUnitPriceMicroLamports: 10_001n },
      { ...base, maxSlippageBps: 51 },
      { ...base, quoteFreshnessMs: 2_001n },
      { ...base, maxRebuildAttempts: 4 },
      { ...base, quoteOutAmount: 457n },
      { ...base, quoteSlippageBps: 31 },
    ]) {
      await expect(
        buildExitTransaction(
          baseSnapshot,
          'DOWN',
          buildConfig({
            nowUnixMs: () => epochNowMs,
            attestationPayloadBytes: encodeAttestationPayload(mutated),
            attestationHash: computeAttestationHash(mutated),
          }),
        ),
      ).rejects.toMatchObject({ code: 'MISSING_ATTESTATION_HASH' });
    }
  });

});
