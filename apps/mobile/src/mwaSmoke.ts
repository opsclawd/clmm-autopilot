import bs58 from 'bs58';

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
