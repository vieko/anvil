# Anvil

**The agent works until a command says done. Not until a model says so.**

The loop is everywhere now: hand an agent an outcome, let it work turn after
turn until something decides it's met. Codex ships it. Claude Code ships it. A
shell script can do it. The loop is the easy half. The half worth choosing is
what you trust to end it.

Anvil ends it on a command's exit code, run in an isolated git worktree the run
can't escape. Not the model that did the work, grading its own evidence. Not a
second model reading the transcript. A command. `npm test` does not care how
persuasive the agent was; it runs the tests and returns a number. The agent
can't talk its way to green, and a run can never touch your working tree.

```
define outcome  →  agent works  →  deterministic gate  →  loop on failure
```

```bash
anvil run "make the failing parser tests pass"
# agent works in an isolated worktree; the gate (tsc + tests) decides done
# + parser-tests: passed in 2 attempts  →  branch anvil/parser-tests/lz4k9
```

Anvil is the reliability-first spine of [forge](https://github.com/vieko/forge),
extracted clean. Forge proved the bet (verification, not a smarter model, is
what makes the output trustworthy), then grew a scheduler, a second workspace
backend, and a daemon around it. Anvil keeps the part that earns the trust: the
gate and the loop are the largest, most-tested, most paranoid code in the repo,
and orchestration is thin glue on top. See **[`docs/design.md`](docs/design.md)**
for the contract and the scope lock.

## What decides done

You can lock down a command. You can't lock down an opinion.

A model grading its own work, or a second model reading the transcript, is still
an opinion. It can be talked around, and "all tests pass" with no run behind it
reads the same as the truth. A command can't be talked around. That is the whole
point, and it is the only thing Anvil accepts as "done".

The honest cost: a command is narrow. It decides "done" only when "done" reduces
to something that exits zero, like a build, a type check, a test, a script you
write. "Tell me where this is most likely to break in production" has no exit
code, so Anvil can't express it. A model judge takes any goal you can phrase;
Anvil takes the ones you can check. No gate, no guarantee.

And the gate doesn't make judgment disappear. It moves it up front, into the
check you write, instead of a verdict at the end. Writing a check that actually
captures what "done" means is the real work, and it is exactly the work a model
judge lets you skip. What Anvil won't hand the agent is the authority to call its
own work done. That stays with a command, or with you.

## Requirements

- [Node.js](https://nodejs.org) >= 22.19.0
- An API key for the model provider. Anvil is built on [Pi](https://pi.dev) and
  inherits its provider/key resolution. The default models (`sonnet` / `opus` /
  `haiku`) route through Vercel's AI Gateway, so set `AI_GATEWAY_API_KEY`, or
  pass `--model <provider>:<id>` and set that provider's key (e.g.
  `ANTHROPIC_API_KEY`).

## Install

Anvil is not yet on npm. Build it from source:

```bash
git clone https://github.com/vieko/anvil.git
cd anvil
npm install
npm run build
npm link --workspace @anvil/cli   # makes `anvil` available globally
```

Or run it straight from source without linking:

```bash
npm run dev -- run "implement feature X" -C /path/to/repo
```

## Usage

```bash
anvil run "<outcome>"                          # outcome to its gate, in an isolated worktree
anvil run specs/feature.md                     # an outcome from a spec file
anvil run "..." -C /path/to/repo               # target another repo (like git -C)
anvil run "..." --verify "npm test"            # explicit gate (repeatable; all must pass)
anvil run "..." --oracle test/contract.test.ts # seed a frozen test the agent must satisfy
anvil run "..." --scope "src/**"               # fence the agent into these paths
anvil run "..." --json                         # machine-readable result on stdout
anvil status                                   # list recorded runs and their state
anvil skills get core                          # print the full agent usage guide
```

Key options (`anvil --help` for the rest):

| Option | Purpose |
| ------ | ------- |
| `-C, --dir <repo>` | Target repository (default: cwd). |
| `--verify "<cmd>"` | Gate command, repeatable. Omit it and Anvil auto-detects typecheck/build/test from `package.json`. |
| `--oracle <file>` | Seed a check (typically a failing test) into the worktree and **freeze** it: the agent must satisfy it, never edit it. The strongest gate. |
| `--scope <glob>` | Fence the agent into these paths; a change outside **voids the run**. |
| `--model <alias\|provider:id>` | Base model: `sonnet` / `opus` / `haiku`, or a concrete `provider:model-id`. Default `sonnet`. |
| `-n, --max-attempts <n>` | Attempt cap before giving up (default `3`). |
| `-v, --verbose` | Stream the agent's tool calls + gate progress to stderr. |
| `--json` | Emit a machine-readable result; human chrome and `-v` move to stderr. |

## How it works

1. Anvil cuts an isolated **linked worktree** on a fresh branch
   `anvil/<id>/<ts>`. Your working tree is never touched; that's an invariant,
   not a feature, so a run can't stomp uncommitted work.
2. The agent (Pi-backed, with `read` / `edit` / `write` / `bash` tools) works
   the outcome inside that worktree.
3. The **gate** runs your verification commands in a clean environment and has
   the only vote on "done":
   - **pass** → Anvil commits the work on the branch and stops.
   - **fail** → the errors go back into the next attempt, and the model climbs
     an **escalation ladder**. Anvil runs the cheapest model that clears the
     gate (Sonnet by default) and reaches for a stronger one only when the gate
     keeps saying no. A model that can't pass wasn't the right model, and the
     gate finds that out by watching it fail, not by guessing up front.
   - **inconclusive** (a flake, a timeout, or no gate at all) → Anvil
     re-verifies instead of feeding garbage back, and never calls it a pass.
4. The loop always ends at the attempt cap. State is persisted at every step (in
   a user-level dir, never in your repo), so `status` is exact and a passed
   outcome is never redone.

Nothing comes back to you until a command says it passed, so by the time you
look, it already builds and the tests are green. You still review: a gate that
can't be talked around can still pass a wrong change, because it only checks what
you wrote. The work lives on its branch; merge it when you're satisfied:

```bash
git -C <repo> merge anvil/<id>/<ts>   # or cherry-pick the commit
```

## Keeping a green honest

A command is only as honest as what it checks, and an agent that can edit the
test can make anything pass: weaken the assertion, skip the case, hardcode the
answer. So Anvil doesn't let it.

- **A frozen oracle** (`--oracle <file>`): seed the check the agent has to clear,
  out of its reach. Edit it, and the run is void.
- **Scope** (`--scope <glob>`): the agent gets a fence, and a change outside it
  voids the run. This one came from a real bug. I asked for one cron route
  migrated and the agent reached into another, like hiring a painter for one room
  and coming home to find they redid the plumbing in another.
- **A false-pass guard**: an empty or provider-errored turn never reaches the
  gate, so a repo that was already green can't be mistaken for work done.

All three can only force a *no*. The gate stays the only path to "done".

## Machine-readable output

For a script or another agent driving Anvil, `anvil run --json` emits one object
(and `anvil status --json` the record ledger). Past the verdict it carries gate
**provenance**, how strong the green is, so the caller can route trust by rule
instead of re-reading the diff:

```jsonc
{
  "id": "parser-tests",
  "passed": true,
  "attempts": 2,
  "finalModel": "sonnet",
  "branch": "anvil/parser-tests/lz4k9",
  "gate": { "commands": ["tsc --noEmit", "npm test"], "source": "explicit" },
  "oracle": true,    // a frozen oracle was enforced (and, since a violation voids the run, held)
  "scope": true      // a scope was enforced (and held)
}
```

A **strong green** (explicit `--verify`, a held oracle, a held scope) is safe to
integrate blind. A **weak green** (auto-detected, no guards) wants a human first.

## Works with

Anvil is a standalone CLI, so any agent harness that can run a shell command can
drive it, no plugin required: phrase the outcome, call `anvil run --json`, and
reconcile the result branch from the verdict. That covers
[Claude Code](https://www.anthropic.com/claude-code), Codex, and other coding
agents, or a plain CI script. `anvil skills get core` prints a harness-agnostic
guide an agent can read to learn how to phrase outcomes and interpret the result.

Under the hood Anvil is built on [Pi](https://pi.dev): its `read` / `edit` /
`write` / `bash` tools and the `PiAgent` driver run on Pi's agent runtime. What
makes it Anvil isn't the model underneath. It's the gate.

## Develop

```bash
npm install
npm run check     # the one gate: biome -> tsc --noEmit -> build -> test
npm test          # vitest only
```

`@anvil/core` is runtime-agnostic (the `.` export imports no node builtins, no
git, no SDK); node-bound seams live behind `@anvil/core/node`. The engine seams
(`Agent` / `Workspace` / `Gate` / `StatePersister`) are injected interfaces, so
the test suite drives the loop with fakes: no real model, git, or filesystem.

## License

[MIT](LICENSE)
