import {
  Connection,
  type Commitment,
  type ConfirmedSignatureInfo,
  type PublicKey,
  type VersionedTransactionResponse,
} from '@solana/web3.js';
import type { SolanaConfig } from './types';

export type ReadonlyRpc = {
  getSlot: () => Promise<number>;
  getLatestBlockhash: () => Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  getAccountInfoExists: (pubkey: PublicKey) => Promise<boolean>;
  getMultipleAccountsInfoExists: (pubkeys: PublicKey[]) => Promise<boolean[]>;
  getSignaturesForAddress: (pubkey: PublicKey, limit?: number) => Promise<ConfirmedSignatureInfo[]>;
  getTransaction: (signature: string) => Promise<VersionedTransactionResponse | null>;
  getBlockTime: (slot: number) => Promise<number | null>;
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
    async getMultipleAccountsInfoExists(pubkeys: PublicKey[]) {
      const infos = await connection.getMultipleAccountsInfo(pubkeys);
      return infos.map(Boolean);
    },
    getSignaturesForAddress: (pubkey: PublicKey, limit = 20) =>
      connection.getSignaturesForAddress(pubkey, { limit }),
    getTransaction: (signature: string) => connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 }),
    getBlockTime: (slot: number) => connection.getBlockTime(slot),
  };
}
