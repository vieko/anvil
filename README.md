# anvil

**Verified outcomes for autonomous agents. Done is proven, not claimed.**

Describe what must be true. anvil runs an agent in an isolated git worktree and
loops until a deterministic gate — a command, not a model — says it's done. The
agent can't talk its way to green, and a run can never touch your working tree.

```
define outcome  →  agent works  →  deterministic gate  →  loop on failure
```

```bash
anvil run "make the failing parser tests pass"
# agent works in an isolated worktree; the gate (tsc + tests) decides done
# + parser-tests: passed in 2 attempts  →  branch anvil/parser-tests/lz4k9
```

anvil is the reliability-first spine of [forge](https://github.com/vieko/forge),
extracted clean. Forge proved the thesis — *verification, not model perfection,
guarantees correctness* — then grew a scheduler, a second workspace backend, and
a daemon around it. anvil keeps the part that earns the trust: the gate and the
loop are the largest, most-tested, most paranoid code; orchestration is thin
glue. See **[`docs/design.md`](docs/design.md)** for the contract and scope lock.

## Why a gate

A model's confidence in its own output is not evidence — only verification is.
Codex and Claude Code both ship a `/goal` command (declare an outcome, the agent
loops until it's met). Same loop; different authority on "done": Codex lets the
working model self-attest; Claude Code has a second model judge the chat
transcript (it runs no commands). Both rest "done" on a model's judgment. anvil's
stop condition is a **command exit code in an isolated worktree**.

The gate doesn't remove judgment — it *relocates* it, from the agent (which can
be convinced) to a verification command you wrote (which can't). The price is
honest: you must be able to express "done" as a check. So anvil is **narrower**
than a model judge and more trustworthy on what it accepts — no gate, no
guarantee.

## Requirements

- [Node.js](https://nodejs.org) >= 22.19.0
- An API key for the model provider. anvil is built on [pi](https://www.npmjs.com/package/@earendil-works/pi-agent-core)
  and inherits its provider/key resolution. The default models (`sonnet` /
  `opus` / `haiku`) route through the Vercel AI Gateway, so set
  `AI_GATEWAY_API_KEY` — or pass `--model <provider>:<id>` and set that
  provider's key (e.g. `ANTHROPIC_API_KEY`).

## Install

anvil is not yet on npm. Build it from source:

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
anvil run "..." --scope "src/**"               # bound which paths the agent may touch
anvil run "..." --json                         # machine-readable result on stdout
anvil status                                   # list recorded runs and their state
anvil skills get core                          # print the full agent usage guide
```

Key options (`anvil --help` for the rest):

| Option | Purpose |
| ------ | ------- |
| `-C, --dir <repo>` | Target repository (default: cwd). |
| `--verify "<cmd>"` | Gate command, repeatable. When omitted, anvil auto-detects typecheck/build/test from `package.json`. |
| `--oracle <file>` | Seed a file (typically a failing test) into the worktree and **freeze** it: the agent must satisfy it, never edit it. The strongest gate. |
| `--scope <glob>` | Restrict which paths the agent may modify; a change outside **voids the run**. Caps blast radius. |
| `--model <alias\|provider:id>` | Base model: `sonnet` / `opus` / `haiku`, or a concrete `provider:model-id`. Default `sonnet`. |
| `-n, --max-attempts <n>` | Attempt cap before giving up (default `3`). |
| `-v, --verbose` | Stream the agent's tool calls + gate progress to stderr. |
| `--json` | Emit a machine-readable result; human chrome and `-v` move to stderr. |

## How it works

1. anvil creates an isolated **linked worktree** on a fresh branch
   `anvil/<id>/<ts>`. Your working tree is never touched — that is a safety
   invariant, not a feature, so a run can't stomp uncommitted work.
2. The agent (pi-backed, with `read` / `edit` / `write` / `bash` tools) works
   the outcome inside that worktree.
3. The **gate** runs the verification commands in a clean environment. It is the
   sole authority on "done" — the agent never votes on its own success.
   - **pass** → anvil commits the work on the branch and stops.
   - **fail** → the gate's errors are fed back into the next attempt, and the
     model/effort climbs an **escalation ladder** (a stronger config each retry).
   - **inconclusive** (a flaky command, a timeout, or *no gate at all*) → anvil
     re-verifies rather than feeding garbage back, and never reports it as a
     pass. No gate, no guarantee.
4. The loop always terminates at the attempt cap. State is persisted at every
   transition (under a user-level dir, never in your repo), so `status` is exact
   and a passed outcome is never redone.

Guards keep a green honest: a **false-pass guard** rejects an empty or
provider-errored agent turn before it reaches the gate; a **frozen oracle**
(`--oracle`) voids the run if the agent edits a check it was supposed to satisfy;
and **`--scope`** voids it if the agent strays outside its blast radius. These
guards can only force a *non*-pass — the gate stays the only path to "done".

The result lives on its branch; integrate it when you're satisfied:

```bash
git -C <repo> merge anvil/<id>/<ts>   # or cherry-pick the commit
```

## Machine-readable output

For script or agent callers, `anvil run --json` emits one object (and
`anvil status --json` the record ledger). Beyond the verdict it carries gate
**provenance** — how strong the green is — so a caller can route trust as a rule
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
integrate blind; a **weak green** (auto-detected, no guards) warrants review.

## Works with

- [pi](https://www.npmjs.com/package/@earendil-works/pi-agent-core) — the agent
  substrate anvil's tools and `PiAgent` are built on.
- [forge](https://github.com/vieko/forge) — the orchestration sibling anvil was
  extracted from; reach for it when you want the full multi-stage lifecycle.
- [Bonfire](https://github.com/vieko/bonfire) — cross-session project memory.

## Develop

```bash
npm install
npm run check     # the one gate: biome -> tsc --noEmit -> build -> test
npm test          # vitest only
```

`@anvil/core` is runtime-agnostic (the `.` export imports no node builtins, no
git, no SDK); node-bound seams live behind `@anvil/core/node`. The engine seams
(`Agent` / `Workspace` / `Gate` / `StatePersister`) are injected interfaces, so
the test suite drives the loop with fakes — no real model, git, or filesystem.

## License

[MIT](LICENSE)
