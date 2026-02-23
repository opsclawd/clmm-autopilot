# Devnet E2E Runbook (M6)

## Web shell UX

1. Install dependencies:
   - `pnpm install`
2. Start web app:
   - `pnpm -C apps/web dev`
3. Open the app and run flow:
   - Click **Connect Wallet**
   - Paste an Orca position account address
   - Click **Fetch snapshot + decision**
   - Verify UI shows:
     - current tick + lower/upper ticks
     - decision + reason code
     - debounce progress + cooldown remaining
     - slippage cap + expected minOut + quote age
   - If decision is `HOLD`, **Execute** remains blocked.
   - If decision is trigger, click **Execute**.
   - Wallet prompt must appear; approve sign+send.
   - Verify tx signature is returned from wallet send.
   - Verify receipt account is fetched after send (flow fails if receipt is not found).
   - Confirmation shows:
     - receipt PDA
     - tx signature
   - Click copy actions for both receipt PDA and tx signature.

## Mobile shell UX

1. Start mobile app:
   - `pnpm -C apps/mobile start`
2. In app:
   - Tap **Connect Wallet (MWA)**
   - Paste Orca position account
   - Tap **Fetch snapshot + decision**
   - Validate same status fields as web (ticks/decision/debounce/cooldown/slippage/minOut/quote age)
   - `HOLD` blocks **Execute**.
   - Trigger decision allows **Execute**.
   - MWA prompt must appear; approve sign+send transaction.
   - Verify tx signature returned from send and receipt fetch succeeds.
   - After execute, verify receipt PDA + tx signature and copy actions.

## Notes

- Phase 1 has no force-path: execution is blocked when decision is `HOLD`.
- UI errors map to canonical reason taxonomy from `SPEC.md`.
