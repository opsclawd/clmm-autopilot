export type SolanaCluster = 'devnet' | 'mainnet-beta' | 'localnet';

export type CanonicalPairError = Error & {
  code: 'NOT_SOL_USDC';
  retryable: false;
  debug?: unknown;
};

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_DEVNET_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const USDC_MAINNET_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export type MintRegistry = {
  sol: string;
  usdc: string;
  allowList: readonly string[];
  symbols: Record<string, 'SOL' | 'USDC'>;
};

function normalizeMint(mint: string): string {
  return mint.trim();
}

export function getMintRegistry(cluster: SolanaCluster): MintRegistry {
  const usdc = cluster === 'mainnet-beta' ? USDC_MAINNET_MINT : USDC_DEVNET_MINT;
  const symbols: Record<string, 'SOL' | 'USDC'> = {
    [SOL_MINT]: 'SOL',
    [usdc]: 'USDC',
  };
  return {
    sol: SOL_MINT,
    usdc,
    allowList: [SOL_MINT, usdc],
    symbols,
  };
}

export function isSolUsdcPair(mintA: string, mintB: string, cluster: SolanaCluster): boolean {
  const a = normalizeMint(mintA);
  const b = normalizeMint(mintB);
  const { sol, usdc } = getMintRegistry(cluster);
  return (a === sol && b === usdc) || (a === usdc && b === sol);
}

export function assertSolUsdcPair(mintA: string, mintB: string, cluster: SolanaCluster): void {
  if (isSolUsdcPair(mintA, mintB, cluster)) return;
  const err = new Error(`Unsupported pair for ${cluster}: ${mintA}/${mintB}`) as CanonicalPairError;
  err.code = 'NOT_SOL_USDC';
  err.retryable = false;
  err.debug = { mintA, mintB, cluster };
  throw err;
}

export function symbolForMint(mint: string, cluster: SolanaCluster): 'SOL' | 'USDC' | 'UNKNOWN' {
  return getMintRegistry(cluster).symbols[normalizeMint(mint)] ?? 'UNKNOWN';
}
