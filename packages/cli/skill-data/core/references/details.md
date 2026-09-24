# anvil — reference details

## Gate verdicts: pass / fail / inconclusive

The gate distinguishes three verdicts, and that distinction is *why* you can
trust it:

- **pass** — every command exited 0 (re-checked for flakes; see below).
- **fail** — a command exited non-zero, repeatably. Actionable: its output is
  fed back to the agent as the next outcome.
- **inconclusive** — the gate could not produce a trustworthy verdict: a command
  could not be run (timeout, spawn failure), an identified crash of the gate's
  own executable/script, a fail-then-pass flake, or there were **no** gate
  commands at all. Errors in the code under test stay ordinary failures. anvil
  re-verifies rather than feeding
  garbage back, and never reports an inconclusive as a pass. "No gate" is a
  refusal to vouch, not a silent success.

Flake-resistance: a command that fails then passes on recheck is treated as
flaky (inconclusive), not a hard failure. A real, repeatable failure dominates
an inconclusive sibling — there is something concrete to fix.

On a fresh run, anvil verifies the untouched fork SHA before dispatch. A
persistently inconclusive baseline voids the run without work; red and green
baselines both proceed. Green is recorded and warned about because it proves
nothing unless the work adds checks.

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

- a **weak base** (sonnet / haiku / sol / luna / ...) jumps to high effort,
  then switches to the strong tier (opus), then climbs opus effort:
  `low -> high -> opus@high -> opus@xhigh -> opus@max`.
- a **strong base** (opus / fable / astra) climbs effort only — no model
  switch: `fable@high -> fable@xhigh -> fable@max`.

With the default cap of 3 attempts, a weak base reaches opus by the final one.
Set the base with `--model` and `--effort`; the climb is automatic. The default
base is `sonnet` at `high` effort, so the default ladder is
`sonnet@high -> opus@high -> opus@xhigh`.

## Model aliases

`haiku` / `sonnet` / `opus` / `fable` resolve to current Anthropic models
(`opus` is Claude Opus 5.5, the default strong tier; `fable` is an opt-in
strong base), `astra` to GPT-6 Astra (an opt-in strong base for jobs that want
1M+ context or OpenAI's strengths), `sol` to GPT-6 Sol (sonnet's price on
OpenAI's route), and `luna` / `terra` / `glm` to budget-tier OpenAI/Z.ai
models, all through the Vercel AI Gateway (one key, `AI_GATEWAY_API_KEY`). Or
pass a concrete `provider:model-id`. The default model is `sonnet` (at `high`
effort).

## Worktree prep: deps, linked files, contracts, scope

Before the agent's first turn, anvil prepares the fresh worktree:

- **Dependencies** install automatically when a lockfile is present (detected
  package manager; pnpm uses the warm store). Once, so the agent does not waste
  an attempt discovering `node_modules` is missing. `--no-install` opts out;
  install failure is fatal. In a large monorepo, a scoped install folded into
  `--verify` (e.g. `pnpm install --filter <pkg>... && pnpm --filter <pkg>
  test:unit`) plus `--no-install` can beat the whole-repo install.
- **Linked files** (`--link <glob>`, repeatable) are linked in (symlink, copy
  fallback) for a gate that needs a gitignored file like `**/.env.local`. Off by
  default: handing real secrets to a worked agent widens the blast radius, so
  opt in deliberately and prefer a deterministic gate that needs none.
- **Contracts** (`--contract <file>`, repeatable) are copied in and committed
  into the worktree base, then frozen: if the agent modifies or deletes one the
  run is voided terminally (never retried, never a pass). The immutable gate
  behind the red-green pattern -- a green run provably satisfied a test the
  agent could not touch.
- **Scope** (`--scope <glob>`, repeatable) bounds which paths the agent may
  modify. After the agent's turn, anvil diffs the worktree against its base; a
  change to any path matching none of the scope globs voids the run terminally
  (same shape as the contract guard). The mirror of `--contract`: the contract
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
it lives on, so `anvil status` points you at the result, and its `usage`
(tokens + USD `cost`, cumulative across `attempts[].usage`), so spend is visible
without a gateway dashboard: rows end in `2.3M ctx  $4.21` (context tokens =
input + cacheRead + cacheWrite; either omitted when unknown) and a footer totals
`N runs, P passed, F failed, $X.XX`. `--since <7d|24h|90m|ISO date>` keeps only
records updated on/after that instant; `--all` reads every repo bucket under the
state root, prefixing rows with the repo name (`anvil status --all --since 7d`).

A non-terminal record (`running`/`verifying`/...) is only ever as trustworthy as
the process behind it: each records the OS `pid` that ran it, and a row whose
`pid` is dead (or, for a record from before this, whose `updatedAt` hasn't moved
in 30 minutes) renders as `stale <age>` (e.g. `stale 16d`) with a distinct mark,
counted separately from `passed`/`failed`/in-flight in the footer. `anvil status
--prune` rewrites every stale row to `state: "failed"` with `note: "orphaned:
process gone, marked by anvil status --prune <ISO date>"`, reports what it
changed, and prints -- but never runs -- the `git worktree remove` command for
that row's worktree when it's still on disk. It never deletes a worktree or a
branch itself.

Cost is priced by anvil from the resolved model's table, not pi's `usage.cost`:
under `PI_CACHE_RETENTION=long` every Anthropic cache write is a 1h write billed
at 2x input, which pi misses through the Vercel AI Gateway (earendil-works/pi#9210).

## Machine-readable output (`--json`)

For script/agent callers, both commands take `--json` (human chrome and the
`-v` stream move to stderr; the JSON goes to stdout, exit codes unchanged):

- `anvil run --json` -> one object:
  `{ id, passed, attempts, timeline, usage?, finalModel, finalEffort, branch,
     gate: { commands, source }, contract, scope, errors? }`.
  `timeline` is the per-attempt history (#12 Tier 3): one entry per attempt with
  its dispatched `config`, `verdict` (`passed`/`failed`/`retrying`/`void`/
  `dispatch-failed`), its own `usage` (`input`, `output`, `cacheRead`,
  `cacheWrite`, and USD `cost`, absent when the model has no price table), and
  `startedAt`/`endedAt`. The top-level `usage` is the cumulative sum. `attempts`
  stays the plain count for compatibility.
- `anvil status --json` -> the record ledger as a JSON array (each record's
  `attempts` field is that same per-attempt history; `--since`/`--all` apply, and
  with `--all` each record gains a `repo` name).

### Routing trust from a green (gate provenance)

`passed: true` says the gate held; the provenance fields say *how strong* that
gate was, so a caller can decide integrate-blind vs. flag-for-review as a rule
instead of re-reading the diff:

- `gate.commands` -- the command strings the gate actually ran (e.g.
  `["tsc --noEmit", "pnpm test:unit"]`); `[]` when the run was voided before any
  verify (a contract violation or out-of-scope edit).
- `gate.source` -- `"explicit"` (you passed `--verify`) vs `"autodetect"` (anvil
  read `package.json`).
- `contract` / `scope` -- true when that guard was enforced. Since any violation
  voids the run, on a pass they also mean the guard *held*.

A practical policy: **strong green** (`source: "explicit"` and `contract` and
`scope`) -> integrate blind; **weak green** (autodetect, no contract, no scope)
-> flag for human review. Counting the weak greens that re-verify wrong is also
the evidence that would reopen a richer selection layer.

Cumulative USD cost and per-attempt history are not in the payload yet (tracked
separately); the fields above are the stable contract.
