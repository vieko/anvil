# anvil — reference details

## Gate verdicts: pass / fail / inconclusive

The gate distinguishes three verdicts, and that distinction is *why* you can
trust it:

- **pass** — every command exited 0 (re-checked for flakes; see below).
- **fail** — a command exited non-zero, repeatably. Actionable: its output is
  fed back to the agent as the next outcome.
- **inconclusive** — the gate could not produce a trustworthy verdict: a command
  could not be run (timeout, spawn failure), a fail-then-pass flake, or there
  were **no** gate commands at all. anvil re-verifies rather than feeding
  garbage back, and never reports an inconclusive as a pass. "No gate" is a
  refusal to vouch, not a silent success.

Flake-resistance: a command that fails then passes on recheck is treated as
flaky (inconclusive), not a hard failure. A real, repeatable failure dominates
an inconclusive sibling — there is something concrete to fix.

## Auto-detection (when you omit --verify)

From `package.json` + lockfile, in order:

- **typecheck** — `<pm> exec tsc --noEmit` (or `npx tsc --noEmit`) when
  `typescript` is a dependency.
- **build** — `<pm> run build` when a `build` script exists.
- **test** — a deterministic variant first: `<pm> run test:unit`, else
  `<pm> run test:ci`, else plain `<pm> test`, when a matching script exists.
  The deterministic tier wins so auto-detection does not pull in a `test`
  script that chains integration/e2e (see the Trap below).

`<pm>` is detected from the lockfile: `bun.lock(b)` -> bun, `pnpm-lock.yaml` ->
pnpm, `yarn.lock` -> yarn, else npm. Prefer `--verify` when you know the exact
check; auto-detection is a convenience, not a contract.

## Choosing the gate: the deterministic tier

anvil's worktree is a fresh, secret-light checkout with no running services --
effectively a CI environment. Gate on the tier built for that:

- **deterministic** (recommended gate): typecheck, lint, unit tests, build.
  These pass without a developer's `.env.local` -- by design, it is what CI
  runs. A build that validates API keys at module load can be made to pass with
  placeholder env; the real keys are never needed for a build or typecheck.
- **integration / e2e** (avoid as the autonomous gate): need a running app, a
  database or live services, a browser, and real secrets. They are flaky and
  environment-dependent -- the gate treats a flake as inconclusive, so an
  autonomous loop wastes attempts chasing noise -- and supplying real secrets to
  a worked agent widens the blast radius.

Trap: a package's plain `test` script may chain all three tiers (e.g.
`vitest && vitest --config integration && playwright test`). Auto-detection
guards against this by preferring a deterministic `test:unit` / `test:ci`
variant over plain `test`, falling back to `test` only when no such variant
exists. If a package has *only* a chained `test`, name the deterministic
script directly (`--verify "<pm> run test:unit"`) or pass an explicit
`--verify`.

## Escalation ladder

Each failed attempt strengthens the (model, effort) pair, so a too-weak base
does not simply loop until the cap:

- a **weak base** (sonnet / haiku / ...) jumps to high effort, then switches to
  the strong tier (opus), then climbs opus effort:
  `low -> high -> opus@high -> opus@xhigh -> opus@max`.
- a **strong base** (opus) climbs effort only — no model switch.

With the default cap of 3 attempts, a weak base reaches opus by the final one.
Set the base with `--model`; the climb is automatic.

## Model aliases

`sonnet` / `opus` / `haiku` resolve to current Anthropic models through the
Vercel AI Gateway (one key, `AI_GATEWAY_API_KEY`). Or pass a concrete
`provider:model-id`. The default base is `sonnet`.

## Worktree prep: deps, shared files, frozen oracles, scope

Before the agent's first turn, anvil prepares the fresh worktree:

- **Dependencies** install automatically when a lockfile is present (detected
  package manager; pnpm uses the warm store). Once, so the agent does not waste
  an attempt discovering `node_modules` is missing. `--no-install` opts out;
  install failure is fatal. In a large monorepo, a scoped install folded into
  `--verify` (e.g. `pnpm install --filter <pkg>... && pnpm --filter <pkg>
  test:unit`) plus `--no-install` can beat the whole-repo install.
- **Shared files** (`--share <glob>`, repeatable) are copied in (symlink, copy
  fallback) for a gate that needs a gitignored file like `**/.env.local`. Off by
  default: handing real secrets to a worked agent widens the blast radius, so
  opt in deliberately and prefer a deterministic gate that needs none.
- **Frozen oracles** (`--oracle <file>`, repeatable) are copied in and committed
  into the worktree base, then frozen: if the agent modifies or deletes one the
  run is voided terminally (never retried, never a pass). The immutable gate
  behind the red-green pattern -- a green run provably satisfied a test the
  agent could not touch.
- **Scope** (`--scope <glob>`, repeatable) bounds which paths the agent may
  modify. After the agent's turn, anvil diffs the worktree against its base; a
  change to any path matching none of the scope globs voids the run terminally
  (same shape as the frozen-oracle guard). The mirror of `--oracle`: freeze
  guards files the agent must *not* touch; scope bounds the set it *may* touch.
  Reach for it when the gate can't fully encode the contract -- it caps the
  blast radius so an agent can't quietly "fix" an unrelated, already-correct
  file in a way the gate doesn't catch (the failure mode that motivated it: a
  worked agent downgrading a route's auth that the structural gate accepted).

## Worktrees: inspect, merge, clean up

Each run leaves a linked worktree at `<repo>-anvil/<safe-branch>` on branch
`anvil/<id>/<ts>` — deliberately, so you can inspect or merge it:

```bash
git -C <repo> log anvil/<id>/<ts>                          # see the commit
git -C <repo> merge anvil/<id>/<ts>                        # integrate it
git -C <repo> worktree list                                # what's around
git -C <repo> worktree remove <repo>-anvil/<safe-branch>   # clean up
```

## State and idempotency

State is persisted at every transition under a user-level state dir
(`$XDG_STATE_HOME/anvil`, else `~/.anvil`), bucketed by repo path rather than
inside the target tree -- so run records and transcripts never show up as
untracked noise in the repo's `git status` (this is what `anvil status` reads).
A run whose record is already terminal is recognized there, so durable state
buys status + not-redoing-passed-work. Each record carries the worktree `branch`
it lives on, so `anvil status` points you at the result.

## Machine-readable output (`--json`)

For script/agent callers, both commands take `--json` (human chrome and the
`-v` stream move to stderr; the JSON goes to stdout, exit codes unchanged):

- `anvil run --json` -> one object:
  `{ id, passed, attempts, finalModel, finalEffort, branch,
     gate: { commands, source }, oracle, scope, errors? }`.
- `anvil status --json` -> the record ledger as a JSON array.

### Routing trust from a green (gate provenance)

`passed: true` says the gate held; the provenance fields say *how strong* that
gate was, so a caller can decide integrate-blind vs. flag-for-review as a rule
instead of re-reading the diff:

- `gate.commands` -- the command strings the gate actually ran (e.g.
  `["tsc --noEmit", "pnpm test:unit"]`); `[]` when the run was voided before any
  verify (a frozen-oracle or out-of-scope edit).
- `gate.source` -- `"explicit"` (you passed `--verify`) vs `"autodetect"` (anvil
  read `package.json`).
- `oracle` / `scope` -- true when that guard was enforced. Since any violation
  voids the run, on a pass they also mean the guard *held*.

A practical policy: **strong green** (`source: "explicit"` and `oracle` and
`scope`) -> integrate blind; **weak green** (autodetect, no oracle, no scope)
-> flag for human review. Counting the weak greens that re-verify wrong is also
the evidence that would reopen a richer selection layer.

Cumulative USD cost and per-attempt history are not in the payload yet (tracked
separately); the fields above are the stable contract.
