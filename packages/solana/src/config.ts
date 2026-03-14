import type { SolanaConfig } from './types';

const allowedClusters = new Set(['devnet', 'mainnet', 'localnet', 'mainnet-beta']);
const allowedCommitments = new Set(['processed', 'confirmed', 'finalized']);

export function loadSolanaConfig(env: Record<string, string | undefined> = process.env): SolanaConfig {
  const rpcUrl = env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
  const clusterRaw = env.SOLANA_CLUSTER ?? 'devnet';
  const cluster = (clusterRaw === 'mainnet-beta' ? 'mainnet' : clusterRaw) as SolanaConfig['cluster'];
  const commitment = (env.SOLANA_COMMITMENT ?? 'confirmed') as SolanaConfig['commitment'];

  if (!allowedClusters.has(clusterRaw)) throw new Error(`Invalid SOLANA_CLUSTER: ${clusterRaw}`);
  if (clusterRaw === 'mainnet-beta') {
    console.warn('[config] SOLANA_CLUSTER=\"mainnet-beta\" is deprecated; use \"mainnet\".');
  }
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
