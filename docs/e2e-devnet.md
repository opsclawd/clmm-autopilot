# Devnet E2E Harness Notes

Single harness location: `packages/solana/src/e2eDevnet.ts`

Run:

```bash
pnpm e2e:devnet
```

Expected behavior:

- Exits `0` on HOLD (policy not triggered)
- Exits `0` on successful TRIGGER execution + receipt verification
- Exits non-zero on any failure/refusal

Structured log steps include:

- `snapshot.fetch.start|ok`
- `policy.evaluate.ok`
- `idempotency.check.ok`
- `quote.fetch.start`
- `tx.build-sim-send.start`
- `tx.simulate.ok`
- `tx.send-confirm.ok`
- `receipt.verify.ok`
- `harness.complete`

Input env values can be sourced from `.env.example`.
