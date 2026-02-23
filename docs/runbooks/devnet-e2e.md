# Devnet E2E (M6 Shell UX)

## Web
1. `pnpm install`
2. `pnpm -C apps/web dev`
3. Connect wallet.
4. Enter a single Orca position account.
5. Click Execute.
6. Verify UI shows:
   - current/lower/upper ticks
   - decision + reasonCode + debounce progress + cooldown
   - slippage cap + expected minOut + quote age
   - receipt PDA + tx signature + receipt fields
7. Use copy actions for receipt PDA and tx signature.

## Mobile
1. `pnpm -C apps/mobile start`
2. Connect wallet with MWA.
3. Enter a single Orca position account.
4. Tap Execute.
5. Verify same required fields and receipt/tx outputs.
6. Use copy actions for receipt PDA and tx signature.

## Phase-1 guardrails
- HOLD decision hard-blocks Execute (no force path).
- Notification adapter is logging-only (no push infra).
