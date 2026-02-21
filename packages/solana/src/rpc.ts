import { Connection, type Commitment, type PublicKey } from '@solana/web3.js';
import type { SolanaConfig } from './types';

export type ReadonlyRpc = {
  getSlot: () => Promise<number>;
  getLatestBlockhash: () => Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  getAccountInfoExists: (pubkey: PublicKey) => Promise<boolean>;
};

export function createReadonlyRpc(config: SolanaConfig): ReadonlyRpc {
  const connection = new Connection(config.rpcUrl, config.commitment as Commitment);

  return {
    getSlot: () => connection.getSlot(),
    getLatestBlockhash: () => connection.getLatestBlockhash(),
    async getAccountInfoExists(pubkey: PublicKey) {
      const info = await connection.getAccountInfo(pubkey);
      return Boolean(info);
    },
  };
}
