# Anvil

<p align="center"><img src="say-no-hero.gif" alt="Anvil" width="100%" /></p>

**Outcome-driven, command-verified agent execution. Check what you can't trust.**

Give Anvil an outcome, and it runs an agent in an isolated git worktree, looping
and feeding back each failure until a gate passes or it hits the attempt cap. The
gate decides done: a command you supply with `--verify`, or an auto-detected
build, typecheck, and test.

Anvil is the reliability-first spine of [forge](https://github.com/vieko/forge),
extracted clean: the gate and the loop are the most-tested, most paranoid code in
the repo, and orchestration is thin glue on top. See
**[`docs/design.md`](docs/design.md)** for the contract and scope lock.

## Requirements

- [Node.js](https://nodejs.org) >= 22.19.0
- A model API key. The default models route through Vercel's AI Gateway, so set
  `AI_GATEWAY_API_KEY` (or pass `--model <provider>:<id>` and set that provider's
  key, e.g. `ANTHROPIC_API_KEY`).

## Install

Build it from source:

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
anvil run "..." --contract test/parser.test.ts # seed a frozen test the agent must satisfy
anvil run "..." --scope "src/**"               # fence the agent into these paths
anvil run "..." --json                         # machine-readable result on stdout
anvil status                                   # list recorded runs and their state
anvil skills get core                          # print the full agent usage guide
```

Key options (`anvil --help` for the rest):

| Option | Purpose |
| ------ | ------- |
| `-C, --dir <repo>` | Target repository (default: cwd). |
| `--from <ref>` | Fork the worktree from this ref (default: `HEAD`); e.g. `main` while on a feature branch. |
| `--verify "<cmd>"` | Gate command, repeatable. Omit it and Anvil auto-detects typecheck/build/test from `package.json`. |
| `--contract <file>` | Seed a check (typically a failing test) into the worktree and **freeze** it: the agent must satisfy it, never edit it. The strongest gate. |
| `--scope <glob>` | Fence the agent into these paths; a change outside **voids the run**. |
| `--model <alias\|provider:id>` | Base model: `haiku` / `sonnet` / `opus`, or a concrete `provider:model-id`. Default `sonnet`. |
| `--effort <level>` | Base reasoning effort: `low` / `medium` / `high` / `xhigh` / `max`. Default `high`. |
| `-n, --max-attempts <n>` | Attempt cap before giving up (default `3`). |
| `-v, --verbose` | Stream the agent's tool calls + gate progress to stderr. |
| `--reasoning` | Also stream the agent's reasoning trace (implies `-v`). Display-only — shows the thinking the model emits; use `--effort` to set its level. |
| `--json` | Emit a machine-readable result; human chrome and `-v` move to stderr. |

## How it works

1. Anvil cuts an isolated **linked worktree** on a fresh branch
   `anvil/<id>/<ts>`. Your working tree is never touched, so a run can't stomp
   uncommitted work.
2. The agent works the outcome inside that worktree (`read` / `edit` / `write` /
   `bash` tools).
3. The **gate** runs your verification commands in a clean environment and has
   the only vote on "done":
   - **pass** → Anvil commits the work and stops.
   - **fail** → the errors feed the next attempt, and the model escalates
     (`sonnet` by default, stronger only when the gate keeps failing).
   - **inconclusive** (a flake, a timeout, or no gate) → Anvil re-verifies rather
     than call it a pass.
4. The loop ends at the attempt cap. State persists outside your repo, so
   `status` is exact and a passed outcome is never redone.

The result lives on its branch. Review, then merge:

```bash
git -C <repo> merge anvil/<id>/<ts>   # or cherry-pick the commit
```

## Guards

An agent that can edit the check can pass anything. The guards stop that:

- `--contract <file>`: seed the check the agent must clear, out of its reach. Edit
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
  "finalModel": "opus",
  "finalEffort": "high",
  "branch": "anvil/parser-tests/lz4k9",
  "gate": { "commands": ["tsc --noEmit", "npm test"], "source": "explicit" },
  "contract": true,  // a contract was enforced (and, since a violation voids the run, held)
  "scope": true      // a scope was enforced (and held)
}
```

## Drive it from any harness

Anvil is a standalone CLI, so any agent or CI script can drive it: phrase the
outcome, call `anvil run --json`, and act on the verdict. No plugin, no lock-in
to one harness; [Claude Code](https://www.anthropic.com/claude-code), Codex, and
the rest all work. `anvil skills get core` prints a guide an agent reads to learn
the conventions.

Built on [Pi](https://pi.dev).

## Develop

```bash
npm install
npm run check     # the one gate: biome -> tsc --noEmit -> build -> test
npm test          # vitest only
```

`@anvil/core` is runtime-agnostic; its node-bound seams (worktree, gate, agent)
live behind `@anvil/core/node`. Those seams (`Agent`, `Workspace`, `Gate`,
`StatePersister`) are injected interfaces, so tests drive the loop with fakes,
no real model, git, or filesystem needed.

## Credits

Animation by [Jon Romero Ruiz](https://x.com/jonroru).

## License

[MIT](LICENSE)
