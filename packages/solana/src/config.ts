import type { SolanaConfig } from './types';

const allowedClusters = new Set(['devnet', 'mainnet-beta', 'localnet']);
const allowedCommitments = new Set(['processed', 'confirmed', 'finalized']);

export function loadSolanaConfig(env: Record<string, string | undefined> = process.env): SolanaConfig {
  const rpcUrl = env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
  const cluster = (env.SOLANA_CLUSTER ?? 'devnet') as SolanaConfig['cluster'];
  const commitment = (env.SOLANA_COMMITMENT ?? 'confirmed') as SolanaConfig['commitment'];

  if (!allowedClusters.has(cluster)) throw new Error(`Invalid SOLANA_CLUSTER: ${cluster}`);
  if (!allowedCommitments.has(commitment)) throw new Error(`Invalid SOLANA_COMMITMENT: ${commitment}`);

  let parsed: URL;
  try {
    parsed = new URL(rpcUrl);
  } catch {
    throw new Error(`Invalid SOLANA_RPC_URL: ${rpcUrl}`);
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Invalid SOLANA_RPC_URL protocol: ${parsed.protocol}`);
  }

  return { rpcUrl, cluster, commitment };
}
