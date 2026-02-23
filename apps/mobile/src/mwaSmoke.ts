import bs58 from 'bs58';
import { VersionedTransaction } from '@solana/web3.js';

export type MwaSmokeResult = {
  publicKey: string;
  signatureBase58: string;
};

export async function runMwaSignMessageSmoke(): Promise<MwaSmokeResult> {
  const mwa = await import('@solana-mobile/mobile-wallet-adapter-protocol-web3js');
  const payload = new TextEncoder().encode('clmm-autopilot-m1-mwa-smoke');

  return mwa.transact(async (wallet: any) => {
    const auth = await wallet.authorize({
      chain: 'solana:devnet',
      identity: { name: 'CLMM Autopilot' },
    });

    const account = auth.accounts[0];
    const signed = await wallet.signMessages({
      addresses: [account.address],
      payloads: [payload],
    });

    const sigBytes: Uint8Array = signed.signedPayloads[0];
    const signatureBase58 = bs58.encode(sigBytes);

    return {
      publicKey: account.address,
      signatureBase58,
    } satisfies MwaSmokeResult;
  });
}

export async function runMwaSignAndSendVersionedTransaction(
  tx: VersionedTransaction,
): Promise<{ signature: string }> {
  const mwa = await import('@solana-mobile/mobile-wallet-adapter-protocol-web3js');

  return mwa.transact(async (wallet: any) => {
    const auth = await wallet.authorize({
      chain: 'solana:devnet',
      identity: { name: 'CLMM Autopilot' },
    });

    const result = await wallet.signAndSendTransactions({
      addresses: [auth.accounts[0].address],
      transactions: [tx.serialize()],
    });

    const firstSig = result.signatures?.[0] ?? result.signature;
    return { signature: typeof firstSig === 'string' ? firstSig : bs58.encode(firstSig) };
  });
}
