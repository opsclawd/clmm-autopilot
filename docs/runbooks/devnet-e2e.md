> ⚠️ Legacy runbook (M6). For current harness operations use `docs/runbook.md` (M12).

# M6 Devnet E2E Runbook (Web + Mobile)

## Prerequisites
- Node + pnpm installed (repo pinned versions preferred).
- `pnpm install` completed at repo root.
- Devnet-funded wallet (SOL for tx + fees).
- Devnet RPC reachable (default public RPC or custom endpoint).
- A devnet Orca Whirlpool position account address to test.

## Standard verification commands
```bash
pnpm -r lint
pnpm -r typecheck
pnpm -r test
```

## Get a devnet position address
Use any owned Orca Whirlpool position account on devnet. If needed, inspect your wallet activity or existing dev tooling to copy the position account pubkey.

## Web flow (`apps/web`)
1. Start app: `pnpm -C apps/web dev`
2. Open UI in browser.
3. Connect wallet.
4. Paste position address.
5. Click **Refresh**.
6. Confirm status panel shows required fields:
   - current/lower/upper tick
   - decision + reasonCode + debounce progress + cooldown remaining
   - slippage cap + expected minOut + quote age
7. Confirm HOLD behavior:
   - When decision is `HOLD`, **Execute** stays disabled.
8. For out-of-range trigger (`TRIGGER_DOWN` or `TRIGGER_UP`):
   - Click **Execute**.
   - Confirm simulation summary appears before wallet prompt.
   - Sign and send transaction.
9. Confirm post-tx section shows:
   - tx signature + copy action
   - receipt PDA + copy action
   - fetched receipt fields

## Mobile flow (`apps/mobile`)
1. Start app: `pnpm -C apps/mobile start`
2. Open dev client, connect with MWA.
3. Paste position address.
4. Tap **Refresh**.
5. Confirm required status fields render (same list as web).
6. Confirm HOLD blocks Execute.
7. On trigger decision, tap **Execute**:
   - simulation summary shown before MWA sign/send
   - sign/send completes
8. Confirm post-tx section shows:
   - tx signature + copy
   - receipt PDA + copy
   - fetched receipt fields

## Notes
- Notifications are stubbed to console logging only.
- No auto-execution, no push infrastructure, no multi-position management in M6.
