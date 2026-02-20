# AGENT — Repo enforcement for OpenClaw/Codex

This file is normative. If CI doesn’t gate it, it’s decoration.

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
- Do not add new dependencies without updating `SPEC.md` (and justifying why).
- Do not “clean up” formatting across the repo as drive-by changes.

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

## 6) CI truth

- CI is the source of truth.
- If a required command is slow/flaky, fix it or explicitly re-scope it in `SPEC.md` with a replacement gate.
