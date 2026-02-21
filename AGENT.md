# AGENT — Repo enforcement for OpenClaw/Codex

This file is normative. If CI doesn’t gate it, it’s decoration.

## Mandatory read set (non-negotiable)

Before any work (every session start), read in this order:
1) `AGENT.md`
2) `SPEC.md`
3) `docs/architecture.md`

Before starting any milestone, also read:
4) `specs/<milestone>.spec.md` (e.g. `specs/m0-scaffold.spec.md`)
5) Any referenced ADRs or docs listed inside that milestone spec

No code changes are allowed until the read set is loaded.

If any instruction conflicts, priority is:
`AGENT.md` > milestone spec > `SPEC.md` > `docs/architecture.md`.

## 1) Artifact-first rule

- Do **not** claim progress unless you provide:
  - branch name, AND
  - pushed commit hash (or PR URL)

## 2) Milestone scope lock

- Exactly **one milestone per branch/PR**.
- If scope expands, open a new milestone/branch.

## 3) TDD gate

- New functionality requires tests.
- Specs and tests come first when behavior is ambiguous.

## 4) Forbidden behavior

- Do not rewrite unrelated files.
- Do not add new dependencies without updating the active milestone spec (and `SPEC.md` when required).
- Do not “clean up” formatting across the repo as drive-by changes.
- Do not implement out-of-scope features; remove them instead of parking them behind TODOs.

## 5) PR description requirements

Every PR description must include the commands executed (copy/paste block):

```bash
pnpm -r test
pnpm -r lint
pnpm -r typecheck
anchor test
# mobile sanity build (one of)
pnpm -C apps/mobile export
# (or) pnpm -C apps/mobile prebuild --check
```

If a command is not applicable, the PR must explain why and link to the updated spec.

## 6) Enforcement

- Any change that violates `docs/architecture.md` boundaries is rejected.
- Any new dependency, new package, or new script requires updating the active milestone spec.
- Every update must include: branch name, commit hash, commands run, and pass/fail results.

## 7) CI truth

- CI is the source of truth.
- If a required command is slow/flaky, fix it or explicitly re-scope it in `SPEC.md` with a replacement gate.
