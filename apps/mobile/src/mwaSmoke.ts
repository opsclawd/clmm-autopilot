export type MwaSmokeResult = {
  publicKey: string;
  signatureHex: string;
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
    const signatureHex = Array.from(sigBytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    return {
      publicKey: account.address,
      signatureHex,
    } satisfies MwaSmokeResult;
  });
}
