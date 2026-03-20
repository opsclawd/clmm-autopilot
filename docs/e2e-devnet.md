# Devnet E2E Harness Notes

Single harness location: `packages/solana/src/e2eDevnet.ts`

Run:

```bash
pnpm receipt:check:devnet
pnpm e2e:devnet
pnpm e2e:certify:devnet
E2E_CERT_SCENARIO=hold-path-debounce E2E_CERT_DIRECTION=DOWN pnpm e2e:certify:devnet
```

For repeatable M22 certification runs, prefer direction-specific candidate inventories:

- `POSITION_ADDRESS_CANDIDATES_DOWN`
- `POSITION_ADDRESS_CANDIDATES_UP`

The harness records every exclusion reason and uses the first deterministic candidate that matches the scenario fixture shape.

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
- Set either `POSITION_ADDRESS` or the direction-specific candidate inventory env vars

Certification artifacts are emitted as JSON (`schemaVersion: 2`) under `artifacts/e2e/devnet/<scenario>/<runId>.json` unless `E2E_ARTIFACT_DIR` is set. Artifacts now include explicit `fixture`, `expectedOutcome`, `prompt`, `tx`, `quote`, `retries`, `blockhash`, `localReceipt`, and `postTrade` sections.
