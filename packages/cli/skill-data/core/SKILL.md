---
name: core
description: anvil core usage — how to delegate a verifiable coding task and read the result. Covers phrasing an outcome (not a procedure), setting the gate (auto-detected or explicit --verify), the isolated-worktree model, escalation on retry, exit codes, and merging the result branch. Read this before running any anvil command.
---

# anvil — core usage

anvil runs **one outcome to a deterministic gate**: you describe *what must be
true* and *how to check it*; an autonomous agent works in an isolated git
worktree until the gate passes (or an attempt cap is hit).

The mental shift: you are **not** writing steps. You state an outcome and a
verification. **The gate — not the agent — decides "done"**, so the quality of
your verification is the quality of the result.

## The command

```bash
anvil run "<outcome>" -C <repo> [--verify "<cmd>"]...
```

- `<outcome>` — a prompt string, or a path to a spec file. A multi-word or
  multi-line argument is always treated as a prompt; an argument that is a path
  to an existing file is read as a spec.
- `-C, --dir <repo>` — the target repository (default: current directory).
  Mirrors `git -C`.
- `--verify "<cmd>"` — the gate command. Repeatable (all must pass). When
  omitted, anvil auto-detects test/typecheck/build from `package.json`.
- `--oracle <file>` — seed a file you wrote (typically a failing test) into the
  worktree and **freeze** it: the agent must satisfy it and cannot edit it.
  Repeatable. The strongest gate (see below).
- `--scope <glob>` — restrict which paths the agent may modify (repeatable;
  e.g. `"apps/api/**"`). A change outside the scope **voids the run**. The
  mirror of `--oracle`: freeze guards files the agent must *not* touch; scope
  bounds the set it *may* touch. Use it to cap blast radius when the gate
  can't fully specify the contract.
- `--model <alias|provider:id>` — base model: `sonnet` / `opus` / `haiku`, or a
  concrete `provider:model-id`. Default `sonnet`.
- `-n, --max-attempts <n>` — attempt cap before giving up (default `3`).
- `--share <glob>` — copy file(s) into the worktree before the run (e.g.
  `"**/.env.local"`); off by default. Use it when a gate needs files git ignores.
- `--no-install` — skip the automatic pre-run dependency install (on by default
  when a lockfile is present; deps are installed once so the agent need not).
- `-q, --quiet` — print only the final verdict.

## Phrase the outcome as a result, not a procedure

The gate gives anvil its leverage; spend it on a clear *result*, not steps.

- GOOD: `implement the slugify function in src/slug.ts so the test suite passes`
- GOOD: `fix the type errors so tsc --noEmit is clean`
- GOOD: `add a GET /health route returning 200 {status:"ok"}, and a test proving it`
- AVOID: `open src/slug.ts and add a regex` — a procedure. anvil will still run,
  but you have thrown away the gate: say what must be **true**.

## The gate is the authority — give it a real check

anvil believes the work is done only when the gate passes. Set it one of two
ways:

1. **Auto-detection** (omit `--verify`): anvil reads `package.json` + the
   lockfile and runs the detected typecheck/build/test commands. Use this in a
   normal Node/TS repo.
2. **Explicit `--verify`** (recommended when you know the check): pass the exact
   command(s) — a precise signal of what "done" means.
3. **Frozen oracle `--oracle <file>`** (the strongest gate): seed a failing test
   you wrote into the worktree; the agent must make it pass and **cannot edit
   it** — any change to a frozen oracle voids the run. Green then means the agent
   satisfied a check it did not author (the red-green / test-first pattern, made
   native). Pair it with `--verify` to run that test.

A frozen oracle is only as good as the contract it encodes; if it under-specifies,
a green run can still be wrong (an agent can "fix" an unrelated file in a way the
gate doesn't see). Add `--scope <glob>` to bound the blast radius — the run voids
if the agent edits anything outside the paths you name.

```bash
anvil run "make the auth tests green" -C ~/app --verify "pnpm test auth"
anvil run "refactor without regressions" --verify "tsc --noEmit" --verify "pnpm test"
```

If no gate is detected and none is supplied, anvil **refuses to vouch** — it
reports *inconclusive* rather than a false pass. No gate, no guarantee.

### Choose a gate that reproduces in a fresh checkout

anvil works in a fresh, secret-light worktree with no running services — a
CI-like checkout. Gate on the **deterministic tier**: typecheck, lint, unit
tests, and build. That is what a good CI pipeline runs, and it passes without a
developer's local secrets.

Do **not** gate an autonomous run on **e2e or live-integration** tests: they
need a running app, a browser, and real credentials; they are flaky by nature
(and the gate treats a flake as inconclusive, burning attempts); and handing a
worked agent real secrets widens the blast radius. Leave those to humans / CI
after merge.

In a monorepo a package's plain `test` script may chain unit + integration +
e2e — prefer the specific deterministic script (e.g. `test:unit`) or an explicit
`--verify`.

## What happens

- anvil creates an isolated **linked worktree** on a branch `anvil/<id>/<ts>`
  and works there. It **never touches your main working tree**, so it cannot
  stomp your uncommitted changes.
- The agent edits; then the gate runs. On failure the gate's errors are fed
  back and the run retries, climbing a model/effort ladder each attempt.
- On the **first** passing gate, anvil commits the work on the branch and stops.
- If the cap is hit with no pass, it fails and reports the last errors.

## Read the result

- Exit code `0` = passed; non-zero = failed or inconclusive.
- The worktree and branch are left in place for inspection. Integrate with:
  ```bash
  git -C <repo> merge anvil/<id>/<ts>     # or cherry-pick the commit
  ```
- `anvil status -C <repo>` lists recorded runs (state, attempt, model).

## When NOT to use anvil

anvil is for **self-contained, verifiable** changes. Do not reach for it when:

- the task is exploratory/interactive or has no objective check — that is a
  hands-on session, where you work in the main tree directly.
- the work spans multiple repos or many tasks — anvil runs **one outcome** at a
  time, by design.

## Going deeper

```bash
anvil skills get core --full
```

for the gate's flake-resistance and inconclusive semantics, the auto-detection
table, the escalation ladder, model aliases, and worktree cleanup.
