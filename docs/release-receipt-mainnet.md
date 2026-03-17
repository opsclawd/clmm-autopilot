# Mainnet Receipt Release (M20)

This runbook is the canonical release path for the Anchor `receipt` program on Solana mainnet.

## Pinned toolchain

- Anchor CLI: `0.32.1`
- Solana/Agave CLI: `2.3.0`
- `solana-verify`: `0.4.12`

`Anchor.toml` also pins the Anchor and Solana versions under `[toolchain]`. Do not run the release from an environment that drifts from these versions.

## Required inputs

- `SOLANA_RPC_URL` or `--rpc-url`
- `ANCHOR_WALLET` or `--wallet`
- `RECEIPT_PROGRAM_KEYPAIR` or `--program-keypair`
- `EXPECTED_UPGRADE_AUTHORITY` or `--expected-upgrade-authority`

The expected upgrade authority is the launch multisig. The operator wallet may deploy, but the release is not complete until authority is transferred to that multisig.

## Dry run

Use the dry run before every mainnet release:

```bash
pnpm receipt:deploy:mainnet -- --dry-run --rpc-url "$SOLANA_RPC_URL" --program-keypair "$RECEIPT_PROGRAM_KEYPAIR" --expected-upgrade-authority "$EXPECTED_UPGRADE_AUTHORITY"
```

The dry run verifies:

- `anchor build --verifiable` runs from `programs/receipt/`
- fixed program identity matches across `declare_id!`, `Anchor.toml`, the supplied program keypair, and the built IDL
- retained `.so` size, rent estimate, and deployer balance are visible before the deploy
- the exact deploy, authority-transfer, and `solana-verify` commands are printed

Do not proceed if the dry run shows any identity mismatch or insufficient deployer balance.

## Release steps

```bash
pnpm receipt:deploy:mainnet -- --rpc-url "$SOLANA_RPC_URL" --program-keypair "$RECEIPT_PROGRAM_KEYPAIR" --expected-upgrade-authority "$EXPECTED_UPGRADE_AUTHORITY"
```

This command performs the release in order:

1. `cd programs/receipt && anchor build --verifiable`
2. `solana program deploy target/deploy/receipt.so --program-id <PROGRAM_KEYPAIR> --url <RPC> --keypair <WALLET>`
3. `solana program set-upgrade-authority <PROGRAM_ID> --new-upgrade-authority <MULTISIG> --url <RPC> --keypair <WALLET>`
4. `solana-verify get-executable-hash deployments/mainnet/receipt.so`
5. `solana-verify get-program-hash -u <RPC> <PROGRAM_ID>`
6. `pnpm receipt:check:mainnet -- --rpc-url <RPC>`

The release fails closed if any step fails. Artifacts are only written after deploy and authority transfer succeed.

## Retained outputs

Preserve these outputs under release control immediately after success:

- `deployments/mainnet/receipt.json`
- `deployments/mainnet/receipt.idl.json`
- `deployments/mainnet/receipt.provenance.json`
- `deployments/mainnet/receipt.verify.json`
- release notes / commit reference for the deployment

`receipt.json` is the canonical runtime manifest. `receipt.verify.json` is the canonical verified-build evidence. `receipt.provenance.json` captures the local build, deploy preflight, and pinned toolchain metadata used for the release.

## Post-release checks

Run both:

```bash
pnpm receipt:check:mainnet -- --rpc-url "$SOLANA_RPC_URL"
solana program show A81Xsuwg5zrT1sgvkncemfWqQ8nymwHS3e7ExM4YnXMm --url "$SOLANA_RPC_URL"
```

Confirm:

- the retained binary hash matches `receipt.json`
- `solana-verify` local and on-chain hashes match
- the observed upgrade authority equals the expected multisig
- the manifest and IDL paths point at retained `deployments/mainnet/` artifacts

## Failure handling

- Identity mismatch before deploy: stop and reconcile `declare_id!`, `Anchor.toml`, or the supplied program keypair. Do not patch source during release.
- Deploy succeeds but authority transfer fails: do not publish artifacts; resolve authority ownership first.
- `solana-verify` hash mismatch: treat the build as untrusted and do not publish `receipt.json`.
- Consistency check failure: do not start or continue mainnet shadow runs until the manifest, retained artifacts, and on-chain program state agree.
