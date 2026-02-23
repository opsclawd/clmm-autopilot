import * as anchor from '@coral-xyz/anchor';
import { expect } from 'chai';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { deriveReceiptPda } from '../packages/solana/src/receipt';

describe('receipt', () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Receipt as anchor.Program;

  const unixTs = 1_739_916_800; // fixed canonical timestamp
  const epoch = Math.floor(unixTs / 86400);

  const authorityA = Keypair.generate();
  const authorityB = Keypair.generate();
  const positionMint = Keypair.generate().publicKey;
  const randomHash = () => Uint8Array.from(Array.from({ length: 32 }, () => Math.floor(Math.random() * 256)));

  const fund = async (kp: Keypair) => {
    const sig = await provider.connection.requestAirdrop(kp.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig, 'confirmed');
  };

  before(async () => {
    await fund(authorityA);
    await fund(authorityB);
  });

  it('creates receipt once and stores fields', async () => {
    const attestationHash = randomHash();
    const [receipt] = deriveReceiptPda({
      authority: authorityA.publicKey,
      positionMint,
      epoch,
      programId: program.programId,
    });

    await program.methods
      .recordExecution(epoch, 0, positionMint, [...attestationHash])
      .accounts({ authority: authorityA.publicKey, receipt, systemProgram: SystemProgram.programId })
      .signers([authorityA])
      .rpc();

    const acc = await program.account.receipt.fetch(receipt);
    expect(acc.authority.toBase58()).to.eq(authorityA.publicKey.toBase58());
    expect(acc.positionMint.toBase58()).to.eq(positionMint.toBase58());
    expect(acc.epoch).to.eq(epoch);
    expect(acc.direction).to.eq(0);
    expect(Buffer.from(acc.attestationHash).equals(Buffer.from(attestationHash))).to.eq(true);
    expect(Number(acc.slot)).to.be.greaterThan(0);
    expect(Number(acc.unixTs)).to.not.eq(0);
  });

  it('duplicate fails with stable account-in-use style error', async () => {
    const [receipt] = deriveReceiptPda({
      authority: authorityA.publicKey,
      positionMint,
      epoch,
      programId: program.programId,
    });

    let errMsg = '';
    try {
      await program.methods
        .recordExecution(epoch, 0, positionMint, [...randomHash()])
        .accounts({ authority: authorityA.publicKey, receipt, systemProgram: SystemProgram.programId })
        .signers([authorityA])
        .rpc();
    } catch (e) {
      errMsg = String(e);
    }

    expect(errMsg.length).to.be.greaterThan(0);
    expect(/already in use|custom program error|Allocate: account Address/.test(errMsg)).to.eq(true);
  });

  it('different epoch succeeds', async () => {
    const epoch2 = epoch + 1;
    const [receipt] = deriveReceiptPda({
      authority: authorityA.publicKey,
      positionMint,
      epoch: epoch2,
      programId: program.programId,
    });

    await program.methods
      .recordExecution(epoch2, 1, positionMint, [...randomHash()])
      .accounts({ authority: authorityA.publicKey, receipt, systemProgram: SystemProgram.programId })
      .signers([authorityA])
      .rpc();

    const acc = await program.account.receipt.fetch(receipt);
    expect(acc.epoch).to.eq(epoch2);
    expect(acc.direction).to.eq(1);
  });

  it('wrong signer fails deterministically', async () => {
    const wrongEpoch = epoch + 2;
    const [receipt] = deriveReceiptPda({
      authority: authorityA.publicKey,
      positionMint,
      epoch: wrongEpoch,
      programId: program.programId,
    });

    let failed = false;
    try {
      await program.methods
        .recordExecution(wrongEpoch, 0, positionMint, [...randomHash()])
        .accounts({ authority: authorityA.publicKey, receipt, systemProgram: SystemProgram.programId })
        .signers([authorityB])
        .rpc();
    } catch {
      failed = true;
    }

    expect(failed).to.eq(true);
  });

  it('data correctness: attestation_hash bytes, direction, position_mint, epoch', async () => {
    const checkEpoch = epoch + 3;
    const attestationHash = randomHash();
    const [receipt] = deriveReceiptPda({
      authority: authorityA.publicKey,
      positionMint,
      epoch: checkEpoch,
      programId: program.programId,
    });

    await program.methods
      .recordExecution(checkEpoch, 1, positionMint, [...attestationHash])
      .accounts({ authority: authorityA.publicKey, receipt, systemProgram: SystemProgram.programId })
      .signers([authorityA])
      .rpc();

    const acc = await program.account.receipt.fetch(receipt);
    expect(acc.epoch).to.eq(checkEpoch);
    expect(acc.direction).to.eq(1);
    expect(acc.positionMint.toBase58()).to.eq(positionMint.toBase58());
    expect(Buffer.from(acc.attestationHash).equals(Buffer.from(attestationHash))).to.eq(true);
  });
});
