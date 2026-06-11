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
- **test** — `<pm> test`, else `<pm> run test:unit`, else `test:ci`, when a
  matching script exists.

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
prefers `test`, so it can pull in e2e. When that is a risk, name the
deterministic script directly (`--verify "<pm> run test:unit"`) or pass an
explicit `--verify`.

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

State is persisted at every transition under the repo's `.anvil/runs` store
(this is what `anvil status` reads). A run whose record is already terminal is
recognized there, so durable state buys status + not-redoing-passed-work.
