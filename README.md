# anvil

The most reliable implementation of:

> **define outcome → agent works → deterministic gate → loop**

Anvil is the clean extraction of [forge](../forge)'s spine. Forge proved the
thesis — *verification, not model perfection, guarantees correctness* — but
accreted a parallel scheduler, a second workspace backend, and a legacy daemon
around it. Anvil keeps the spine and sheds the rest: the gate and the loop are
the most-tested, most paranoid part of the system; orchestration is thin glue.

See **[`docs/design.md`](docs/design.md)** for the contract and scope lock.

## anvil vs. the `/goal` commands

Codex and Claude Code both ship a `/goal` command — declare an outcome, the
agent keeps working until it's met. Same loop as anvil; different authority on
"done". Codex lets the working model mark itself complete; Claude Code asks a
separate model to judge the chat transcript (it runs no commands). Both rest
"done" on a model's judgment. anvil's stop condition is a **command exit code in
an isolated worktree** — the agent can't talk its way to green, and a run can't
stomp your working tree. The closest competitor is `claude -p "/goal …"`; the
difference is the gate.

## Layout

```
packages/core/        @anvil/core — the engine
  src/index.ts        .       pure, runtime-agnostic (runToGate, escalation, types)
  src/node.ts         ./node  node-bound seams (pi-backed Agent, worktree Workspace, gate)
packages/cli/         @anvil/cli — the `anvil run` + `status` surface
docs/design.md        the engine design + scope lock
```

## Develop

```sh
npm install
npm run check     # biome -> tsc --noEmit -> build -> test
npm test          # vitest
```

## Status

Phase A4 complete — the engine runs end to end and ships a first-class CLI.
`runToGate` drives `PiAgent` (pi's `AgentHarness` + anvil's read/edit/write/bash
tools) inside a `WorktreeWorkspace` (git worktree), verified by `CommandGate`,
with the fail-then-retry-then-pass loop and an escalation ladder. The
`@anvil/cli` surface (`anvil run` + `status`) is a thin layer over the finished
engine, at parity with forge's `run <spec>` common case. See `docs/design.md` §7.
