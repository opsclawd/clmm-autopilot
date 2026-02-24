export type SolanaCluster = 'devnet' | 'mainnet-beta' | 'localnet';

export type CanonicalPairError = Error & {
  code: 'NOT_SOL_USDC';
  retryable: false;
  debug?: unknown;
};

const SOL_NATIVE_MARKER = 'SOL_NATIVE';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_DEVNET_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const USDC_MAINNET_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export type MintRegistry = {
  sol: typeof SOL_NATIVE_MARKER;
  wsol: string;
  usdc: string;
  allowList: readonly string[];
  symbols: Record<string, 'SOL' | 'USDC'>;
};

function normalizeMint(mint: string): string {
  return mint.trim();
}

function canonicalizeMint(mint: string, registry: MintRegistry): string {
  const normalized = normalizeMint(mint);
  if (normalized === registry.sol || normalized === registry.wsol) return registry.sol;
  if (normalized === registry.usdc) return registry.usdc;
  return normalized;
}

export function getMintRegistry(cluster: SolanaCluster): MintRegistry {
  const usdc = cluster === 'mainnet-beta' ? USDC_MAINNET_MINT : USDC_DEVNET_MINT;
  const symbols: Record<string, 'SOL' | 'USDC'> = {
    [SOL_NATIVE_MARKER]: 'SOL',
    [WSOL_MINT]: 'SOL',
    [usdc]: 'USDC',
  };

  return {
    sol: SOL_NATIVE_MARKER,
    wsol: WSOL_MINT,
    usdc,
    allowList: [SOL_NATIVE_MARKER, WSOL_MINT, usdc],
    symbols,
  };
}

export function isSolUsdcPair(mintA: string, mintB: string, cluster: SolanaCluster): boolean {
  const registry = getMintRegistry(cluster);
  const a = canonicalizeMint(mintA, registry);
  const b = canonicalizeMint(mintB, registry);
  return (a === registry.sol && b === registry.usdc) || (a === registry.usdc && b === registry.sol);
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
  const registry = getMintRegistry(cluster);
  return registry.symbols[normalizeMint(mint)] ?? 'UNKNOWN';
}

export function getCanonicalPairLabel(cluster: SolanaCluster): string {
  const registry = getMintRegistry(cluster);
  return `${registry.symbols[registry.sol]}/${registry.symbols[registry.usdc]}`;
}
