# Mobile MWA smoke runbook (M1)

## Prereqs

- Android emulator or physical Android device
- A Solana mobile wallet that supports MWA

## Install + run

```bash
pnpm install
pnpm --filter @clmm-autopilot/mobile smoke:mwa
```

Then launch Android:

```bash
pnpm --filter @clmm-autopilot/mobile android
```

## Smoke steps

1. Open the app.
2. Tap **Run MWA sign-message smoke**.
3. Approve wallet authorization + message signing.
4. Verify the app displays:
   - wallet public key
   - signature (base58)

## Notes

- Uses devnet chain id (`solana:devnet`).
- CI does not perform interactive signing; this runbook is for local/device verification.
