import { describe, expect, it, vi } from 'vitest';
import { PublicKey, TransactionInstruction, TransactionMessage } from '@solana/web3.js';
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

const txSigHash = new Uint8Array(32).fill(7);

function buildConfig(overrides?: Partial<BuildExitConfig>): BuildExitConfig {
  const quote: ExitQuote = {
    inputMint: SOL_MINT,
    outputMint: USDC_MINT,
    slippageBps: 30,
    quotedAtUnixMs: 1_700_000_000_000,
  };

  return {
    authority: pk(18),
    payer: pk(19),
    recentBlockhash: 'EETubP5AKH2uP8WqzU7xYfPqBrM6oTnP3v8igJE6wz7A',
    computeUnitLimit: 600_000,
    computeUnitPriceMicroLamports: 10_000,
    conditionalAtaIxs: [ix(21), ix(22)],
    removeLiquidityIx: ix(31),
    collectFeesIx: ix(32),
    jupiterSwapIx: ix(33),
    buildWsolLifecycleIxs: () => ({ preSwap: [ix(23)], postSwap: [ix(24)] }),
    quote,
    maxSlippageBps: 50,
    quoteFreshnessMs: 2_000,
    maxRebuildAttempts: 3,
    nowUnixMs: () => 1_700_000_000_500,
    rebuildSnapshotAndQuote: async () => ({ snapshot: baseSnapshot, quote: { ...quote, quotedAtUnixMs: 1_700_000_000_200 } }),
    availableLamports: 5_000_000,
    estimatedNetworkFeeLamports: 20_000,
    estimatedPriorityFeeLamports: 5_000,
    estimatedRentLamports: 2_039_280,
    estimatedAtaCreateLamports: 2_039_280,
    feeBufferLamports: 10_000,
    txSigHash,
    simulate: async () => ({ err: null, accountsResolved: true }),
    ...overrides,
  };
}

describe('buildExitTransaction', () => {
  it('builds instruction ordering with receipt final and canonical epoch', async () => {
    const config = buildConfig();
    const result = await buildExitTransaction(baseSnapshot, 'DOWN', config);
    expect(result).toBeInstanceOf(TransactionMessage);

    const msg = result as TransactionMessage;
    const order = msg.instructions.map((i) => i.programId.toBase58());

    // compute budget x2, ata x2, full wsol lifecycle x2, remove, collect, swap, receipt(final)
    expect(order.length).toBe(10);
    expect(msg.instructions[2].programId.toBase58()).toBe(pk(21).toBase58());
    expect(msg.instructions[3].programId.toBase58()).toBe(pk(22).toBase58());
    expect(msg.instructions[4].programId.toBase58()).toBe(pk(23).toBase58());
    expect(msg.instructions[5].programId.toBase58()).toBe(pk(31).toBase58());
    expect(msg.instructions[6].programId.toBase58()).toBe(pk(32).toBase58());
    expect(msg.instructions[7].programId.toBase58()).toBe(pk(33).toBase58());
    expect(msg.instructions[8].programId.toBase58()).toBe(pk(24).toBase58());

    const finalIx = msg.instructions[msg.instructions.length - 1];
    expect(finalIx.data.length).toBe(77);
    const epoch = finalIx.data.readUInt32LE(8);
    expect(epoch).toBe(Math.floor(config.nowUnixMs() / 1000 / 86400));
  });

  it('tight slippage aborts safely without rebuild attempts', async () => {
    const rebuildSpy = vi.fn(async () => ({ snapshot: baseSnapshot, quote: buildConfig().quote }));
    await expect(
      buildExitTransaction(baseSnapshot, 'DOWN', buildConfig({ quote: { ...buildConfig().quote, slippageBps: 55 }, rebuildSnapshotAndQuote: rebuildSpy })),
    ).rejects.toMatchObject({ code: 'SLIPPAGE_EXCEEDED' });
    expect(rebuildSpy).toHaveBeenCalledTimes(0);
  });

  it('stale quote triggers deterministic rebuild path', async () => {
    const rebuiltQuote: ExitQuote = {
      inputMint: SOL_MINT,
      outputMint: USDC_MINT,
      slippageBps: 30,
      quotedAtUnixMs: 1_700_000_000_400,
    };
    const rebuildSpy = vi.fn(async () => ({ snapshot: baseSnapshot, quote: rebuiltQuote }));
    const config = buildConfig({
      quote: { ...buildConfig().quote, quotedAtUnixMs: 1_699_999_990_000 },
      rebuildSnapshotAndQuote: rebuildSpy,
    });

    await buildExitTransaction(baseSnapshot, 'DOWN', config);
    expect(rebuildSpy).toHaveBeenCalledTimes(1);
  });

  it('simulate-then-send gate cannot be bypassed', async () => {
    await expect(
      buildExitTransaction(
        baseSnapshot,
        'DOWN',
        buildConfig({ simulate: async () => ({ err: new Error('sim err'), accountsResolved: true }) }),
      ),
    ).rejects.toMatchObject({ code: 'SIMULATION_FAILED' });

    await expect(
      buildExitTransaction(
        baseSnapshot,
        'DOWN',
        buildConfig({ simulate: async () => ({ err: null, accountsResolved: false }) }),
      ),
    ).rejects.toMatchObject({ code: 'SIMULATION_FAILED' });
  });

  it('builder output is deterministic for fixed snapshot + quote', async () => {
    const config = buildConfig();
    const a = (await buildExitTransaction(baseSnapshot, 'DOWN', config)) as TransactionMessage;
    const b = (await buildExitTransaction(baseSnapshot, 'DOWN', config)) as TransactionMessage;

    const normalize = (m: TransactionMessage) =>
      m.instructions.map((ixx) => `${ixx.programId.toBase58()}:${Buffer.from(ixx.data).toString('hex')}`);

    expect(normalize(a)).toEqual(normalize(b));
  });
});
