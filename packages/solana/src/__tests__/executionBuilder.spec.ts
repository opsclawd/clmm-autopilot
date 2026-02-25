import { describe, expect, it } from 'vitest';
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
    attestationPayloadBytes: new Uint8Array(236),
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
  };

  const hasPayloadOverride = Boolean(overrides && Object.prototype.hasOwnProperty.call(overrides, 'attestationPayloadBytes'));
  const hasHashOverride = Boolean(overrides && Object.prototype.hasOwnProperty.call(overrides, 'attestationHash'));
  if (!hasPayloadOverride) merged.attestationPayloadBytes = encodeAttestationPayload(attestationInput);
  if (!hasHashOverride) merged.attestationHash = computeAttestationHash(attestationInput);
  return merged;
}

describe('buildExitTransaction', () => {
  it('builds instruction ordering with receipt final', async () => {
    const result = await buildExitTransaction(baseSnapshot, 'DOWN', buildConfig());
    expect(result).toBeInstanceOf(TransactionMessage);
    const msg = result as TransactionMessage;
    expect(msg.instructions[msg.instructions.length - 1].data.length).toBe(77);
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
        buildConfig({ attestationHash: new Uint8Array(32).fill(7), attestationPayloadBytes: new Uint8Array(236).fill(1) }),
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
});
