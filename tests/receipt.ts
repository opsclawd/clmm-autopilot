import * as anchor from '@coral-xyz/anchor';
import { expect } from 'chai';
import { PublicKey, SystemProgram } from '@solana/web3.js';

describe('receipt', () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Receipt as anchor.Program;

  const epochFromNow = () => Math.floor(Date.now() / 1000 / 86400);

  const randomPositionMint = () => anchor.web3.Keypair.generate().publicKey;
  const randomHash = () => Uint8Array.from(Array.from({ length: 32 }, () => Math.floor(Math.random() * 256)));

  function deriveReceiptPda(authority: PublicKey, positionMint: PublicKey, epoch: number): PublicKey {
    const epochLe = Buffer.alloc(4);
    epochLe.writeUInt32LE(epoch);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('receipt'), authority.toBuffer(), positionMint.toBuffer(), epochLe],
      program.programId,
    );
    return pda;
  }

  it('creates receipt once and stores fields', async () => {
    const authority = provider.wallet.publicKey;
    const positionMint = randomPositionMint();
    const epoch = epochFromNow();
    const txSigHash = randomHash();
    const receipt = deriveReceiptPda(authority, positionMint, epoch);

    await program.methods
      .recordExecution(epoch, 0, positionMint, [...txSigHash])
      .accounts({ authority, receipt, systemProgram: SystemProgram.programId })
      .rpc();

    const acc = await program.account.receipt.fetch(receipt);
    expect(acc.authority.toBase58()).to.eq(authority.toBase58());
    expect(acc.positionMint.toBase58()).to.eq(positionMint.toBase58());
    expect(acc.epoch).to.eq(epoch);
    expect(acc.direction).to.eq(0);
    expect(Buffer.from(acc.txSigHash).equals(Buffer.from(txSigHash))).to.eq(true);
    expect(Number(acc.slot)).to.be.greaterThan(0);
  });

  it('fails deterministically on duplicate (same authority, mint, epoch)', async () => {
    const authority = provider.wallet.publicKey;
    const positionMint = randomPositionMint();
    const epoch = epochFromNow();
    const txSigHash = randomHash();
    const receipt = deriveReceiptPda(authority, positionMint, epoch);

    await program.methods
      .recordExecution(epoch, 1, positionMint, [...txSigHash])
      .accounts({ authority, receipt, systemProgram: SystemProgram.programId })
      .rpc();

    let failed = false;
    try {
      await program.methods
        .recordExecution(epoch, 1, positionMint, [...randomHash()])
        .accounts({ authority, receipt, systemProgram: SystemProgram.programId })
        .rpc();
    } catch {
      failed = true;
    }
    expect(failed).to.eq(true);
  });

  it('succeeds for different epoch', async () => {
    const authority = provider.wallet.publicKey;
    const positionMint = randomPositionMint();
    const epochA = epochFromNow();
    const epochB = epochA + 1;

    const receiptA = deriveReceiptPda(authority, positionMint, epochA);
    const receiptB = deriveReceiptPda(authority, positionMint, epochB);

    await program.methods
      .recordExecution(epochA, 0, positionMint, [...randomHash()])
      .accounts({ authority, receipt: receiptA, systemProgram: SystemProgram.programId })
      .rpc();

    await program.methods
      .recordExecution(epochB, 0, positionMint, [...randomHash()])
      .accounts({ authority, receipt: receiptB, systemProgram: SystemProgram.programId })
      .rpc();

    const accA = await program.account.receipt.fetch(receiptA);
    const accB = await program.account.receipt.fetch(receiptB);
    expect(accA.epoch).to.eq(epochA);
    expect(accB.epoch).to.eq(epochB);
  });

  it('fails with wrong signer for authority account', async () => {
    const attacker = anchor.web3.Keypair.generate();
    const positionMint = randomPositionMint();
    const epoch = epochFromNow();
    const receipt = deriveReceiptPda(provider.wallet.publicKey, positionMint, epoch);

    const ix = await program.methods
      .recordExecution(epoch, 0, positionMint, [...randomHash()])
      .accounts({
        authority: provider.wallet.publicKey,
        receipt,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new anchor.web3.Transaction().add(ix);
    tx.feePayer = attacker.publicKey;
    tx.recentBlockhash = (await provider.connection.getLatestBlockhash()).blockhash;
    tx.sign(attacker);

    let failed = false;
    try {
      await provider.connection.sendRawTransaction(tx.serialize());
    } catch {
      failed = true;
    }

    expect(failed).to.eq(true);
  });

  it('rejects invalid direction', async () => {
    const authority = provider.wallet.publicKey;
    const positionMint = randomPositionMint();
    const epoch = epochFromNow();
    const receipt = deriveReceiptPda(authority, positionMint, epoch);

    let failed = false;
    try {
      await program.methods
        .recordExecution(epoch, 3, positionMint, [...randomHash()])
        .accounts({ authority, receipt, systemProgram: SystemProgram.programId })
        .rpc();
    } catch {
      failed = true;
    }

    expect(failed).to.eq(true);
  });
});
