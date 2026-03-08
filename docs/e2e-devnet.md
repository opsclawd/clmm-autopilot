# Devnet E2E Harness Notes

Single harness location: `packages/solana/src/e2eDevnet.ts`

Run:

```bash
pnpm receipt:check:devnet
pnpm e2e:devnet
```

For repeatable same-day receipt proofs, prefer `POSITION_ADDRESS_CANDIDATES` with multiple wallet-owned positions. The harness will skip candidates that already have a receipt for the current UTC-day epoch and use the first fresh SOL/USDC position.

Expected behavior:

- Exits `0` on HOLD (policy not triggered)
- Exits `0` on successful TRIGGER execution + receipt verification + duplicate-block proof
- Exits non-zero on any failure/refusal

Structured log steps include:

- `receipt.program.verify.ok`
- `snapshot.fetch.start|ok`
- `policy.evaluate.ok`
- `receipt.precheck.ok`
- `quote.fetch.start`
- `tx.build-sim-send.start`
- `tx.simulate.ok`
- `tx.send-confirm.ok`
- `receipt.postcheck.ok`
- `receipt.verify.ok`
- `receipt.duplicate-block.ok`
- `harness.complete`

Input env values can be sourced from `.env.example`.

Manual/CI receipt-proof mode:

- Set `REQUIRE_RECEIPT_PROOF=1` to fail on `HOLD`
- Optionally set `FORCE_DECISION=TRIGGER_DOWN|TRIGGER_UP` to guarantee trigger-path execution for idempotency proof
- Set either `POSITION_ADDRESS` or `POSITION_ADDRESS_CANDIDATES`
