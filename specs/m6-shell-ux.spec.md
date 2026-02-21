# M6 — Shell UX

## Goal

Ship the user flow on both web and mobile: monitor position, confirm trigger readiness, and execute one-click (user signs).

## Scope

### In scope

- `apps/web`:
  - dev console UI:
    - wallet connect
    - input position address
    - show snapshot + range status
    - show debounce state (“pending confirm”)
    - execute button to sign/send
- `apps/mobile`:
  - store-grade minimal UI with same flow
  - MWA signing + send
- Notifications:
  - stub adapter (logging + interface) only, no background service requirement

### Out of scope

- Auto-execution
- Push notification infra
- Multi-position portfolio views

## Required deliverables

- Shared UI state model (typed) that consumes snapshot + policy decision
- UI error mapping uses canonical taxonomy from `SPEC.md`
- “Execute” path:
  - fetch snapshot
  - compute decision
  - build tx unsigned
  - simulate
  - present to user
  - sign/send
  - display confirmation including receipt PDA and tx signature
- Runbook:
  - `docs/runbooks/devnet-e2e.md` exact steps to reproduce end-to-end

## Acceptance criteria (pass/fail)

Pass only if:

1. End-to-end devnet runbook succeeds on both web and mobile.
2. UI blocks execution if decision is `HOLD` unless user explicitly forces (force requires extra confirmation UI step).
3. Receipt is observable post-tx (fetch and display receipt fields).

## Definition of Done

- Working E2E on devnet with audited receipt proof.
