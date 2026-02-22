# Mobile MWA smoke runbook (M1)

## Prereqs

- Android emulator or physical Android device
- A Solana mobile wallet that supports MWA
- Android SDK / Studio configured on host

## One-time setup

```bash
pnpm install
cd apps/mobile
pnpm exec expo prebuild --platform android --clean
```

## Build and launch dev client

```bash
cd apps/mobile
pnpm exec expo run:android
```

## Start Metro for MWA smoke

In a second terminal:

```bash
pnpm --filter @clmm-autopilot/mobile smoke:mwa
```

## Smoke steps

1. Open the app in the Android emulator/device.
2. Tap **Run MWA sign-message smoke**.
3. Approve wallet authorization + message signing.
4. Verify the app displays:
   - wallet public key
   - signature (base58)

## Notes

- Uses devnet chain id (`solana:devnet`).
- `expo-dev-client` is required for deep-link based MWA testing.
- CI does not perform interactive signing; this runbook is for local/device verification.
