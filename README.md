# Anvil

**The agent works until a command says done. Not until a model says so.**

Anvil delegates a coding task to an autonomous agent. The agent works in an
isolated git worktree, and the run succeeds only when a deterministic gate
passes: a command you supply with `--verify`, or an auto-detected build,
typecheck, and test. Describe what must be true and how to check it, and Anvil
loops the agent, feeding back every failure, until the gate is green or it hits
the attempt cap.

A command, not a model, has the only vote on "done", so a run can't talk its way
to green, and it never touches your working tree. The catch is that Anvil only
takes outcomes you can check; the reasoning is in [Say No](https://vieko.dev/say-no).

```
define outcome  →  agent works  →  deterministic gate  →  loop on failure
```

```bash
anvil run "make the failing parser tests pass"
# agent works in an isolated worktree; the gate (tsc + tests) decides done
# + parser-tests: passed in 2 attempts  →  branch anvil/parser-tests/lz4k9
```

Anvil is the reliability-first spine of [forge](https://github.com/vieko/forge),
extracted clean: the gate and the loop are the most-tested, most paranoid code in
the repo, and orchestration is thin glue on top. See
**[`docs/design.md`](docs/design.md)** for the contract and scope lock.

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
   `anvil/<id>/<ts>`. Your working tree is never touched, so a run can't stomp
   uncommitted work.
2. The agent (Pi-backed, with `read` / `edit` / `write` / `bash` tools) works
   the outcome inside that worktree.
3. The **gate** runs your verification commands in a clean environment and has
   the only vote on "done":
   - **pass** → Anvil commits the work on the branch and stops.
   - **fail** → the errors go back into the next attempt, and the model climbs an
     **escalation ladder** (cheapest model that clears the gate, Sonnet by
     default, stronger only when the gate keeps failing).
   - **inconclusive** (a flake, a timeout, or no gate at all) → Anvil re-verifies
     instead of feeding garbage back, and never calls it a pass.
4. The loop always ends at the attempt cap. State is persisted at every step (in
   a user-level dir, never in your repo), so `status` is exact and a passed
   outcome is never redone.

Nothing comes back until a command says it passed, so the work already builds and
the tests are green by the time you look. You still review, then merge:

```bash
git -C <repo> merge anvil/<id>/<ts>   # or cherry-pick the commit
```

## Guards

A command is only as honest as what it checks, and an agent that can edit the
test can make anything pass. So Anvil doesn't let it:

- `--oracle <file>`: seed the check the agent must clear, out of its reach. Edit
  it, and the run is void.
- `--scope <glob>`: fence the agent into a set of paths. A change outside voids
  the run.
- false-pass guard: an empty or provider-errored turn never reaches the gate.

All three can only force a no. The gate stays the only path to "done".

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
`write` / `bash` tools and the `PiAgent` driver run on Pi's agent runtime.

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
